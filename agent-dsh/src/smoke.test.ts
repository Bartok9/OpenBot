import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The whole bridge, end to end, against a mock DeepSeek endpoint.
 *
 * This spawns the real adapter, which spawns the real dsh runtime (the same cordis.yml a
 * deployment uses), pointed at a local server speaking the DeepSeek chat-completions wire format.
 * The mock answers with a bash tool call, the harness actually executes it in the workspace, and
 * the AG-UI stream coming back out is asserted event by event. Everything is exercised except
 * DeepSeek itself.
 *
 * Opt-in because it needs this package's dependencies installed and a Node ≥22.19 on PATH for the
 * runtime, neither of which the repository-wide test run guarantees:
 *
 *   cd agent-dsh && bun run smoke
 */
const enabled = process.env.DSH_SMOKE === "1";

type SseEvent = { type: string } & Record<string, unknown>;

/** The chat-completion request bodies the mock received, oldest first. */
const providerRequests: Array<{
  messages: Array<{ role: string; content?: unknown }>;
}> = [];

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const usage = { prompt_tokens: 10, completion_tokens: 5 };

/** One streamed model answer, shaped exactly like DeepSeek's chat.completion.chunk frames. */
function providerAnswer(body: {
  messages: Array<{ role: string; content?: unknown }>;
}): string {
  const last = body.messages.at(-1);
  if (last?.role === "tool") {
    return [
      sse({
        choices: [
          { delta: { role: "assistant", content: "Smoke complete: " } },
        ],
      }),
      sse({
        choices: [{ delta: { content: String(last.content ?? "").trim() } }],
      }),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage }),
      "data: [DONE]\n\n",
    ].join("");
  }
  return [
    sse({
      choices: [
        { delta: { role: "assistant", content: "Running the check." } },
      ],
    }),
    sse({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_smoke_1",
                type: "function",
                function: {
                  name: "bash",
                  arguments:
                    '{"command":"echo smoke-hello","description":"Echo the smoke marker"}',
                },
              },
            ],
          },
        },
      ],
    }),
    sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage }),
    "data: [DONE]\n\n",
  ].join("");
}

async function readJson(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

let provider: Server;
let providerPort = 0;
let adapter: Subprocess | undefined;
const adapterPort = 4299;
let scratch = "";

async function agUiRun(
  runId: string,
  messages: unknown[],
): Promise<SseEvent[]> {
  const response = await fetch(`http://127.0.0.1:${adapterPort}/ag-ui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "smoke-thread",
      runId,
      messages,
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as SseEvent);
}

describe.skipIf(!enabled)("agent-dsh end to end", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "agent-dsh-smoke-"));

    provider = createServer(async (req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        const body = JSON.parse(await readJson(req)) as {
          messages: Array<{ role: string; content?: unknown }>;
        };
        providerRequests.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(providerAnswer(body));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((ready) => provider.listen(0, "127.0.0.1", ready));
    const address = provider.address();
    providerPort = typeof address === "object" && address ? address.port : 0;

    adapter = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        PORT: String(adapterPort),
        DEEPSEEK_API_KEY: "smoke-test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerPort}`,
        DSH_WORKSPACE: join(scratch, "workspace"),
        DSH_SESSION_ROOT: join(scratch, "sessions"),
      },
      stdout: "inherit",
      stderr: "inherit",
    });

    for (let attempt = 0; ; attempt += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${adapterPort}/health`);
        if (health.ok) break;
      } catch {
        // Not listening yet.
      }
      if (attempt > 100) throw new Error("agent-dsh never became healthy");
      await new Promise((wake) => setTimeout(wake, 200));
    }
  }, 60_000);

  afterAll(async () => {
    adapter?.kill();
    await adapter?.exited;
    await new Promise((done) => provider?.close(done));
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test("a run streams text, executes bash in the harness, and finishes", async () => {
    const events = await agUiRun("smoke-run-1", [
      {
        id: "standing",
        role: "system",
        content: "You are Smokey, the smoke-test coworker.",
      },
      { id: "u1", role: "user", content: "Run the smoke check." },
    ]);

    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");

    const types = events.map((event) => event.type);
    expect(types).toContain("TEXT_MESSAGE_START");
    expect(types).toContain("TEXT_MESSAGE_END");

    const text = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("");
    expect(text).toContain("Running the check.");
    expect(text).toContain("Smoke complete:");

    const start = events.find((event) => event.type === "TOOL_CALL_START");
    expect(start?.toolCallName).toBe("bash");
    const result = events.find((event) => event.type === "TOOL_CALL_RESULT");
    // The command really ran: its output came back through the harness's own executor.
    expect(String(result?.content)).toContain("smoke-hello");

    // The harness saw the standing role and the person's message, delivered once.
    const modelSaw = JSON.stringify(providerRequests[0]?.messages ?? []);
    expect(modelSaw).toContain("You are Smokey");
    expect(modelSaw).toContain("Run the smoke check.");
  }, 120_000);

  test("a second run continues the same harness session without a recap", async () => {
    const before = providerRequests.length;
    const events = await agUiRun("smoke-run-2", [
      {
        id: "standing",
        role: "system",
        content: "You are Smokey, the smoke-test coworker.",
      },
      { id: "u1", role: "user", content: "Run the smoke check." },
      {
        id: "a1",
        role: "assistant",
        content: "Running the check. Smoke complete: smoke-hello",
      },
      { id: "u2", role: "user", content: "Anything else to report?" },
    ]);

    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    const request = providerRequests.at(before);
    const modelSaw = JSON.stringify(request?.messages ?? []);
    // Same session: the first turn's history is already there, said once.
    expect(modelSaw).toContain("Run the smoke check.");
    expect(modelSaw).toContain("Anything else to report?");
    expect(modelSaw).not.toContain("[Earlier conversation");
    expect(modelSaw).not.toContain(
      "You are Smokey, the smoke-test coworker.\n\n[New message]",
    );
  }, 120_000);
});
