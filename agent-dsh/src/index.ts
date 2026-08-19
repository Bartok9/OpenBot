import { mkdirSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import {
  DeepSeekHarness,
  TransportClosedError,
} from "@deepseek-ai/dsh-sdk-client";
import {
  type AgUiEvent,
  createRunTranslator,
  type IncomingMessage,
  planPrompt,
} from "./translate.ts";

/**
 * A Bot whose brain is DeepSeek Harness (dsh), DeepSeek's open-source agent harness.
 *
 * The other two Bots in the box are model loops whose every tool comes from the caller and runs on
 * the surface. This one is the opposite kind of coworker: the harness brings its own hands — bash,
 * file tools, subagents, todo lists, context compaction — and executes them itself, inside this
 * container, in its own workspace. What crosses the AG-UI stream is the same protocol the other
 * Bots speak: streamed assistant text, plus each harness tool call as a completed call with its
 * result, so the person watches the work without the surface ever being asked to execute it.
 *
 * The harness runs as a subprocess (the `dsh-jsonrpc-agent` runtime composed by ../cordis.yml),
 * driven over stdio JSON-RPC by the official SDK client. Conversations map one AG-UI thread to one
 * dsh session, so the harness keeps its own durable memory of a channel between runs.
 *
 * What this Bot does not do: call OpenBot's frontend tools. `input.tools` (the computer_* browser
 * tools) is not forwarded, because the SDK wire has no channel for caller-executed tools yet. Asked
 * to fetch a page, the coworker uses its own shell instead — a different trust model, stated in
 * agent-dsh/README.md: this Bot's actions live in its container and its session log, not in the
 * OpenBot gateway audit.
 */

// Compose passes unset optionals as empty strings (`${VAR:-}`), and an empty string must mean
// "unset" here: `env()` treats blank as absent so defaults actually apply.
function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

const PORT = Number.parseInt(env("PORT") ?? "4202", 10);
const PROVIDER = env("DSH_PROVIDER") ?? "deepseek-official";
const MODEL = env("DSH_MODEL") ?? "deepseek-v4-flash";
/** Optional per-request output cap, inherited by the harness's in-process subagents. */
const MAX_TOKENS = positiveInteger(env("DSH_MAX_TOKENS"));
/** Optional shared secret. Set it and OpenBot must send `Authorization: Bearer <token>`. */
const AUTH_TOKEN = env("DSH_AUTH_TOKEN");
/** The Node that runs the harness subprocess. dsh requires Node ^22.19 || >=24. */
const NODE_BIN = env("DSH_NODE_BIN") ?? "node";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Where the harness's bash and file tools act. A volume in Docker; a dotdir on a laptop. */
const WORKSPACE = resolve(
  env("DSH_WORKSPACE") ?? resolve(PACKAGE_ROOT, ".dsh/workspace"),
);
/** Where the harness writes its own durable session log, one JSONL file per conversation. */
const SESSION_ROOT = resolve(
  env("DSH_SESSION_ROOT") ?? resolve(PACKAGE_ROOT, ".dsh/sessions"),
);

/**
 * The deployment-wide persona, compiled into the harness's system prompt. Coworker-specific
 * standing roles arrive per conversation from OpenBot and are delivered inside the first prompt.
 */
const PERSONA =
  env("DSH_SYSTEM_PROMPT") ??
  [
    "You are a coworker on an OpenBot deployment, powered by DeepSeek Harness.",
    "You work inside your own workspace with shell and file tools; what you run there is yours to run.",
    "You have no browser and no OpenBot computer tools. Asked about a web page, fetch it with your shell (for example curl) and answer from what came back.",
    "Messages may carry standing instructions from the platform; treat them as your role and follow them across the whole conversation.",
    "Report what you actually did, concisely.",
  ].join("\n");

/**
 * Refusing to start matches the posture of the other Bots in the box: a missing key should fail in
 * front of whoever is deploying, not as a conversation that errors in front of somebody using it.
 */
if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error(
    "DEEPSEEK_API_KEY is not set. agent-dsh drives DeepSeek Harness, which cannot answer without it.",
  );
  process.exit(1);
}

mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(SESSION_ROOT, { recursive: true });

/** The `dsh-jsonrpc-agent` runtime bin, resolved from this package's own dependencies. */
const RUNTIME_BIN = createRequire(import.meta.url).resolve(
  "@deepseek-ai/dsh-sdk-jsonrpc-demo/bin",
);
const CORDIS_CONFIG = resolve(PACKAGE_ROOT, "cordis.yml");

function positiveInteger(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function buildHarness(): DeepSeekHarness {
  // The runtime reads these straight from its environment, where a blank value would beat its
  // built-in defaults; blanks are dropped so "unset in Compose" means what it says.
  const runtimeEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "DEEPSEEK_BASE_URL",
    "DSH_REASONING_EFFORT",
    "DSH_SESSION_COMPRESSION",
  ]) {
    if (!runtimeEnv[name]?.trim()) delete runtimeEnv[name];
  }
  return new DeepSeekHarness({
    launch: {
      command: NODE_BIN,
      args: [RUNTIME_BIN, CORDIS_CONFIG],
      cwd: PACKAGE_ROOT,
      env: {
        ...runtimeEnv,
        DSH_CWD: WORKSPACE,
        DSH_SESSION_ROOT: SESSION_ROOT,
        DSH_SYSTEM_PROMPT: PERSONA,
      },
      // Bounds each JSON-RPC exchange (initialize, prompt enqueue), not the turn: a turn may
      // legitimately run for minutes and its events arrive as notifications.
      requestTimeoutMs: 120_000,
    },
    cwd: WORKSPACE,
    provider: PROVIDER,
    model: MODEL,
    ...(MAX_TOKENS === undefined ? {} : { maxTokens: MAX_TOKENS }),
  });
}

/**
 * What this process remembers about one AG-UI thread. The durable conversation lives in two other
 * places — OpenBot's thread store and the harness's session log — so losing this map (a restart)
 * costs nothing that `planPrompt`'s recap cannot restore into a fresh harness session.
 */
type ThreadState = {
  sessionId: string;
  /** Message ids already delivered to the harness session, so each is forwarded exactly once. */
  seen: Set<string>;
  /** Whether the harness session has heard anything yet; false means the recap path. */
  known: boolean;
  /** Tail of this thread's run queue. Runs on one thread serialize; threads run concurrently. */
  chain: Promise<void>;
};

let harness = buildHarness();
const threads = new Map<string, ThreadState>();
/** Suffix distinguishing this process's harness sessions from a predecessor's in the session log. */
let sessionEpoch = Math.random().toString(36).slice(2, 8);

/**
 * The runtime subprocess died (crash, OOM, kill). The owned client is terminal after transport
 * loss, so the harness is replaced whole; thread state is dropped with it because those sessions
 * lived in the dead process. The next run on any thread starts a fresh session and restores
 * context from OpenBot's copy of the conversation.
 */
async function replaceHarness(): Promise<void> {
  const failed = harness;
  threads.clear();
  sessionEpoch = Math.random().toString(36).slice(2, 8);
  harness = buildHarness();
  await failed.close().catch(() => {});
}

/** One dsh session id per thread: recognizable in the session log, safe as a file name. */
function sessionIdFor(threadId: string): string {
  const slug = threadId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48);
  return `agui-${slug}-${sessionEpoch}`;
}

function threadFor(threadId: string): ThreadState {
  const existing = threads.get(threadId);
  if (existing) return existing;
  const created: ThreadState = {
    sessionId: sessionIdFor(threadId),
    seen: new Set(),
    known: false,
    chain: Promise.resolve(),
  };
  threads.set(threadId, created);
  return created;
}

const encoder = new EventEncoder();

async function runAgent(
  input: RunAgentInput,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(200, {
    "content-type": encoder.getContentType(),
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // A person closing the tab must not kill the turn: the harness has no mid-turn cancel, and a
  // half-executed bash command is worse than a finished one nobody watched. The run continues to
  // idle so the session log stays whole; only the relay stops.
  let open = true;
  res.on("close", () => {
    open = false;
  });
  const send = (event: AgUiEvent) => {
    if (open)
      res.write(
        encoder.encodeSSE(event as Parameters<typeof encoder.encodeSSE>[0]),
      );
  };

  send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });

  const thread = threadFor(input.threadId);
  const turn = thread.chain.then(async () => {
    const plan = planPrompt({
      messages: input.messages as IncomingMessage[],
      sessionIsNew: !thread.known,
      seen: thread.seen,
    });

    if (plan.prompt === null) {
      // Nothing new to say — a replayed history, or a run carrying only echoes of our own output.
      send({
        type: "RUN_FINISHED",
        threadId: input.threadId,
        runId: input.runId,
      });
      return;
    }

    const translator = createRunTranslator(input.runId, send);
    try {
      await harness.session(thread.sessionId).run(plan.prompt, {
        onNotification(notification) {
          if (
            notification.method === "session.event" &&
            notification.params.sessionId === thread.sessionId
          ) {
            translator.onSessionEvent(notification.params.event);
          }
        },
      });
      // The prompt reached the harness session; these messages are never sent again.
      thread.known = true;
      for (const id of plan.seenIds) thread.seen.add(id);

      const { error } = translator.finish();
      if (error) {
        send({ type: "RUN_ERROR", message: error });
      } else {
        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        });
      }
    } catch (error) {
      translator.finish();
      send({
        type: "RUN_ERROR",
        message:
          error instanceof Error
            ? error.message
            : "DeepSeek Harness could not answer.",
      });
      if (error instanceof TransportClosedError) {
        console.error("dsh runtime is gone; replacing it:", error.message);
        await replaceHarness();
      }
    }
  });
  // The chain must survive a failed run, and this run's response must end either way.
  thread.chain = turn.catch(() => {});
  await turn.catch(() => {});
  res.end();
}

function readBody(
  request: NodeJS.ReadableStream,
  limit: number,
): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new Error("Request body is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () =>
      resolveBody(Buffer.concat(chunks).toString("utf8")),
    );
    request.on("error", rejectBody);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        provider: PROVIDER,
        model: MODEL,
        framework: "deepseek-harness",
      }),
    );
    return;
  }

  if (url.pathname === "/ag-ui" && req.method === "POST") {
    if (AUTH_TOKEN && req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "This agent requires its authorization header.",
        }),
      );
      return;
    }
    let input: RunAgentInput;
    try {
      const body = await readBody(req, 10 * 1024 * 1024);
      const parsed = JSON.parse(body) as RunAgentInput;
      if (
        typeof parsed.threadId !== "string" ||
        typeof parsed.runId !== "string" ||
        !Array.isArray(parsed.messages)
      ) {
        throw new Error("Not a RunAgentInput.");
      }
      input = parsed;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: "The request body is not an AG-UI run." }),
      );
      return;
    }
    await runAgent(input, res);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found." }));
});

server.listen(PORT, () => {
  console.info(`agent-dsh listening on http://localhost:${PORT}/ag-ui`);
});

/** The runtime subprocess is owned, so it is reaped on the way out rather than orphaned. */
async function shutdown(code: number): Promise<void> {
  server.close();
  await harness.close().catch(() => {});
  process.exit(code);
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(130));
