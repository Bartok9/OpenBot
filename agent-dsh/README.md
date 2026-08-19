# agent-dsh — DeepSeek Harness as an OpenBot coworker

An adapter between OpenBot's AG-UI contract and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`), DeepSeek's open-source agent harness. It makes a dsh agent registrable as a Bot the same
way as any other AG-UI endpoint: from `/agents`, from the tenant package, or via
`MANAGED_AGENT_AG_UI_URL`.

## What kind of Bot this is

`agent-bot` and `agent-langgraph` are model loops with no hands of their own: every tool arrives
from the caller and runs on the surface, governed by the OpenBot gateway. This Bot is the opposite
kind of coworker. DeepSeek Harness brings its own hands — `bash`, `read`/`write`/`edit`, an
in-process `subagent`, `todo_write`, automatic context compaction — and executes them itself,
inside this container, in its own `/workspace`.

What crosses the wire is still plain AG-UI. Assistant text streams as `TEXT_MESSAGE_*` events, and
every tool the harness runs is reported as a completed call — `TOOL_CALL_START/ARGS/END` plus a
`TOOL_CALL_RESULT` — which is AG-UI's way of saying "this already happened over there". The surface
renders the activity; it is never asked to execute it.

### The trust model, stated plainly

This Bot's actions do **not** pass through the OpenBot gateway, so they do not appear in
`/admin/audit` and `AGENT_COMPUTER_POLICY` does not apply to them. Its boundary is the container:
a dedicated `dsh-workspace` volume, no access to Bot computers or browser logins, and a port bound
to loopback. Its audit trail is the harness's own append-only session log, one JSONL file per
conversation in the `dsh-sessions` volume, which records every prompt, model step, tool call, and
tool result verbatim.

Anyone who can POST to `/ag-ui` can make this container run shell commands. Compose binds the port
to `127.0.0.1`; set `DSH_AUTH_TOKEN` to also require `Authorization: Bearer <token>`, and store the
same header on the coworker when registering it (OpenBot keeps agent authorization headers
write-only).

## How the bridge works

```
OpenBot server ──AG-UI (SSE)──▶ src/index.ts ──stdio JSON-RPC──▶ dsh-jsonrpc-agent runtime
                                    │                                  (composed by cordis.yml)
                                    └─ one dsh session per AG-UI thread
```

- The adapter owns one dsh runtime subprocess, spawned via `@deepseek-ai/dsh-sdk-client` — the
  official SDK for driving a harness from another process. The runtime's whole composition (model
  adapter, tools, persistence, compaction) is [`cordis.yml`](cordis.yml); change the agent by
  changing rows there.
- One AG-UI thread maps to one dsh session, so the harness keeps its own durable memory of a
  channel. OpenBot resends the full conversation on every run; `src/translate.ts` forwards each
  message once and drops the rest as echoes.
- The coworker's standing role (the system message OpenBot prepends) is delivered inside the
  session's first prompt. The deployment-wide persona lives in `DSH_SYSTEM_PROMPT`.
- If the adapter or runtime restarts, threads continue: the next run starts a fresh dsh session and
  restores context as a compact transcript recap, because OpenBot's thread store is the source of
  truth for the conversation.
- dsh session events map onto AG-UI events: `assistant/chunk` text deltas stream as
  `TEXT_MESSAGE_CONTENT`, each model step becomes one assistant message, `tool/call`/`tool/result`
  become completed tool calls, and an errored turn ends the run as `RUN_ERROR`.

## Running it

Set `DEEPSEEK_API_KEY` in `.env` and start the stack; `scripts/start.sh` includes `agent-dsh`
whenever the key is present and skips it otherwise. Then register a coworker at `/agents` with the
endpoint `http://localhost:4202/ag-ui`, or declare it in the tenant package:

```yaml
- id: harness-engineer
  name: Harness Engineer
  title: Software Engineering
  role_description: Investigate, script, and build things in your own workspace.
  type: remote-ag-ui
  endpoint: http://localhost:4202/ag-ui
```

Without Docker (`bun run dev`): the adapter itself runs under Bun, but the runtime it spawns is
started with `node`, which must be Node `^22.19 || >=24` (dsh's requirement). Point
`DSH_NODE_BIN` at a specific binary if the default `node` is the wrong one.

| Variable               | Default                       | Meaning                                                            |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `DEEPSEEK_API_KEY`     | — (required)                  | DeepSeek credential; the service refuses to start without it.      |
| `DEEPSEEK_BASE_URL`    | DeepSeek's public API         | Alternative chat-completions endpoint.                             |
| `DSH_MODEL`            | `deepseek-v4-flash`           | Model for every conversation.                                      |
| `DSH_REASONING_EFFORT` | `high`                        | Thinking effort: `off`, `low`, `high`, or `max`.                   |
| `DSH_SYSTEM_PROMPT`    | built-in persona              | Base persona compiled into the harness system prompt.              |
| `DSH_MAX_TOKENS`       | adapter default               | Output cap per model request, inherited by subagents.              |
| `DSH_AUTH_TOKEN`       | unset                         | Require this bearer token on `/ag-ui`.                             |
| `DSH_WORKSPACE`        | `/workspace` (Docker)         | Where bash and file tools act.                                     |
| `DSH_SESSION_ROOT`     | `/data/sessions` (Docker)     | Where the harness writes its session log.                          |
| `DSH_NODE_BIN`         | `node`                        | Node executable used to spawn the runtime.                         |
| `PORT`                 | `4202`                        | The adapter's own port.                                            |

## Tests

```sh
bun test           # protocol translation, no dependencies needed
bun run smoke      # the whole bridge: real adapter + real dsh runtime + mock DeepSeek endpoint
```

The smoke test boots the same runtime composition a deployment uses, points it at a local server
speaking DeepSeek's chat-completions wire format, has the model call `bash`, and asserts the
command's real output arrives back as a `TOOL_CALL_RESULT` on the AG-UI stream.

## Known limitations

- **Frontend tools are not forwarded.** `input.tools` (the `computer_*` browser tools) never reach
  the harness: the SDK wire has no channel for caller-executed tools yet. Asked about a web page,
  the coworker uses its own shell instead. If dsh grows client-side tool support, forwarding them
  would put this Bot's browsing under the gateway like the other Bots.
- **No mid-turn cancel.** The SDK protocol cannot abandon a prompt, so a person closing the channel
  stops the relay but the harness finishes its turn; the result lands in its session log.
- **Developer preview.** deepseek-harness states plainly that there will be breaking changes; every
  `@deepseek-ai/*` package here is pinned exactly, and moving the pins is a deliberate act.
