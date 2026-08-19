# The DeepSeek Harness Bot. Unlike agent-bot and agent-langgraph, whose every tool runs on the
# surface, this container is where the work actually happens: the harness executes bash and file
# tools here, in /workspace, and keeps its own session log in /data/sessions. Both are volumes in
# docker-compose.yml so a rebuilt container keeps its files and its memory.
#
# Two stages because the repository installs with bun while deepseek-harness requires Node
# (^22.19 || >=24) at runtime: bun produces node_modules from the repo's own lockfile format, and
# the Node image runs both the adapter (via type stripping) and the dsh runtime it spawns.
FROM oven/bun:1.3 AS deps

WORKDIR /app/agent-dsh
COPY agent-dsh/package.json agent-dsh/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:24-slim

WORKDIR /app/agent-dsh
COPY --from=deps /app/agent-dsh/node_modules ./node_modules
COPY agent-dsh/package.json agent-dsh/cordis.yml ./
COPY agent-dsh/src ./src

ENV PORT=4202
ENV DSH_WORKSPACE=/workspace
ENV DSH_SESSION_ROOT=/data/sessions
EXPOSE 4202
CMD ["node", "src/index.ts"]
