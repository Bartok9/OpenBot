/**
 * Pure translation between the two protocols this adapter bridges.
 *
 * One direction: OpenBot sends AG-UI `RunAgentInput`, whose whole conversation arrives on every
 * run; deepseek-harness keeps its own durable session log and wants only what is new. `planPrompt`
 * decides what one run actually says to the harness.
 *
 * Other direction: the harness streams durable `session.event` envelopes (`assistant/chunk`,
 * `tool/call`, `tool/result`, `turn/end`); AG-UI wants `TEXT_MESSAGE_*` and `TOOL_CALL_*` events.
 * `createRunTranslator` is that state machine.
 *
 * Everything here is deliberately structural: the harness is in developer preview and its wire
 * shapes are external input, so events are narrowed field by field and unknown ones are skipped
 * rather than trusted. No imports, so the whole file is testable without the SDK installed.
 */

/** One AG-UI event, exactly as it goes onto the SSE stream. */
export type AgUiEvent = { type: string } & Record<string, unknown>;

/** One message as AG-UI delivers it in `RunAgentInput.messages`. */
export type IncomingMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The readable text of an AG-UI message. Plain string content passes through; multimodal part
 * arrays keep their text parts and name the rest, so a dropped image is visible rather than silent.
 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (typeof part.type === "string") {
      parts.push(`[${part.type} attachment omitted]`);
    }
  }
  return parts.join("\n");
}

/** Roles that carry instructions rather than conversation. */
const INSTRUCTION_ROLES = new Set(["system", "developer"]);
/** Roles a person (or the platform speaking as one) writes. */
const INPUT_ROLES = new Set(["user", "system", "developer"]);

/** How much restored transcript one recap may carry. The tail survives: newest context wins. */
const RECAP_MAX_CHARS = 6_000;

export type PromptPlan = {
  /** What to say to the harness, or null when this run brings nothing new to say. */
  prompt: string | null;
  /** Every message id this run has now accounted for, to be marked seen after the send. */
  seenIds: string[];
};

/**
 * Decide what one AG-UI run says to the harness.
 *
 * The harness session is the durable memory, so a message is forwarded once. `seen` is what this
 * process already forwarded; `sessionIsNew` says the harness session has heard nothing yet — first
 * contact with a thread, or a thread whose session died with a previous runtime. On a new session
 * the earlier conversation is restored as a recap, because OpenBot's thread is the source of truth
 * and the harness deserves to know what was already said.
 */
export function planPrompt(options: {
  messages: IncomingMessage[];
  sessionIsNew: boolean;
  seen: ReadonlySet<string>;
}): PromptPlan {
  const { messages, sessionIsNew, seen } = options;
  const seenIds = messages.map((message) => message.id);

  // The trailing run of user/system messages is this turn's input; everything before it is
  // history the harness either already has (seen) or gets back as recap (new session).
  let inputStart = messages.length;
  while (inputStart > 0) {
    const candidate = messages[inputStart - 1];
    if (!candidate || !INPUT_ROLES.has(candidate.role)) break;
    inputStart -= 1;
  }

  // Instructions travel once wherever they sit: OpenBot prepends the standing role at position
  // zero on every run, and this is where a copy already delivered is dropped.
  const instructions: string[] = [];
  const input: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (seen.has(message.id)) continue;
    const text = messageText(message.content).trim();
    if (!text) continue;
    if (INSTRUCTION_ROLES.has(message.role)) {
      instructions.push(text);
      continue;
    }
    // On a new session, user messages before the trailing block are told through the recap; on a
    // session that already heard the thread, an unseen user message anywhere is simply new.
    if (message.role === "user" && (!sessionIsNew || index >= inputStart)) {
      input.push(text);
    }
  }

  const recap = sessionIsNew ? recapOf(messages.slice(0, inputStart)) : "";

  const sections: string[] = [];
  if (instructions.length > 0) {
    sections.push(
      `[Standing instructions from the OpenBot platform]\n${instructions.join("\n\n")}`,
    );
  }
  if (recap) {
    sections.push(`[Earlier conversation, restored by the platform]\n${recap}`);
  }
  if (input.length > 0) {
    const text = input.join("\n\n");
    sections.push(sections.length > 0 ? `[New message]\n${text}` : text);
  }

  return {
    prompt: sections.length > 0 ? sections.join("\n\n") : null,
    seenIds,
  };
}

/** The prior conversation as a compact transcript, newest tail kept within the recap budget. */
function recapOf(history: IncomingMessage[]): string {
  const lines: string[] = [];
  for (const message of history) {
    if (message.role === "user") {
      const text = messageText(message.content).trim();
      if (text) lines.push(`Person: ${text}`);
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = messageText(message.content).trim();
    const calls = Array.isArray(message.toolCalls)
      ? message.toolCalls
          .map((call) =>
            isRecord(call) && isRecord(call.function)
              ? call.function.name
              : undefined,
          )
          .filter((name): name is string => typeof name === "string")
      : [];
    if (text) lines.push(`You: ${text}`);
    else if (calls.length > 0) lines.push(`You: (used ${calls.join(", ")})`);
  }
  const recap = lines.join("\n");
  if (recap.length <= RECAP_MAX_CHARS) return recap;
  return `(older messages omitted)\n${recap.slice(recap.length - RECAP_MAX_CHARS)}`;
}

/** Model-facing tool results can be enormous; the transcript needs the shape, not every byte. */
const TOOL_RESULT_MAX_CHARS = 16_000;

/**
 * The stream state machine for one AG-UI run.
 *
 * The harness reports durable session facts; AG-UI wants an ordered event stream with explicit
 * opens and closes. Text deltas open a message lazily and `assistant/message` closes it, so one
 * harness turn with three model steps becomes three assistant messages, each carrying the tool
 * calls it made. Tool calls the harness executed itself are emitted as completed calls with a
 * `TOOL_CALL_RESULT`, which is how AG-UI says "this happened over there": the surface renders the
 * activity and never mistakes it for a call it should execute.
 */
export function createRunTranslator(
  runId: string,
  emit: (event: AgUiEvent) => void,
): {
  onSessionEvent(event: unknown): void;
  finish(): { error?: string };
} {
  let sequence = 0;
  let openTextId: string | null = null;
  let lastMessageId: string | null = null;
  let turnError: string | undefined;

  const closeText = () => {
    if (!openTextId) return;
    emit({ type: "TEXT_MESSAGE_END", messageId: openTextId });
    openTextId = null;
  };

  const openText = () => {
    if (openTextId) return openTextId;
    sequence += 1;
    openTextId = `msg_${runId}_${sequence}`;
    lastMessageId = openTextId;
    emit({
      type: "TEXT_MESSAGE_START",
      messageId: openTextId,
      role: "assistant",
    });
    return openTextId;
  };

  return {
    onSessionEvent(event: unknown): void {
      if (
        !isRecord(event) ||
        typeof event.type !== "string" ||
        !isRecord(event.data)
      ) {
        return;
      }
      const data = event.data;

      if (event.type === "assistant/chunk") {
        const chunk = data.chunk;
        if (!isRecord(chunk) || chunk.type !== "text-delta") return;
        const text = typeof chunk.text === "string" ? chunk.text : "";
        if (!text) return;
        emit({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: openText(),
          delta: text,
        });
        return;
      }

      if (event.type === "assistant/message") {
        // Streamed text closes here. Text that never streamed (an adapter that answered whole,
        // or a turn resumed from a checkpoint) is delivered as one message so it is not lost.
        if (openTextId) {
          closeText();
          return;
        }
        const message = isRecord(data.message) ? data.message : undefined;
        const text = flattenText(message?.content);
        if (!text) return;
        const messageId = openText();
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: text });
        closeText();
        return;
      }

      if (event.type === "tool/call") {
        closeText();
        const callId =
          typeof data.callId === "string"
            ? data.callId
            : `call_${runId}_${sequence}`;
        const name = typeof data.name === "string" ? data.name : "tool";
        const args =
          typeof data.arguments === "string" && data.arguments
            ? data.arguments
            : "{}";
        emit({
          type: "TOOL_CALL_START",
          toolCallId: callId,
          toolCallName: name,
          ...(lastMessageId ? { parentMessageId: lastMessageId } : {}),
        });
        emit({ type: "TOOL_CALL_ARGS", toolCallId: callId, delta: args });
        emit({ type: "TOOL_CALL_END", toolCallId: callId });
        return;
      }

      if (event.type === "tool/result") {
        const message = isRecord(data.message) ? data.message : undefined;
        const block = Array.isArray(message?.content)
          ? message.content[0]
          : undefined;
        if (!isRecord(block) || typeof block.toolCallId !== "string") return;
        const text = flattenText(block.content) || "(no output)";
        const bounded =
          text.length <= TOOL_RESULT_MAX_CHARS
            ? text
            : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… (truncated by the OpenBot adapter)`;
        emit({
          type: "TOOL_CALL_RESULT",
          messageId: `msg_${runId}_result_${block.toolCallId}`,
          toolCallId: block.toolCallId,
          content: bounded,
          role: "tool",
        });
        return;
      }

      if (event.type === "turn/end") {
        // The run settles on whole-agent idle, which one errored turn does not prevent; the last
        // turn's ending decides how the AG-UI run reports itself.
        const reason = isRecord(data.reason) ? data.reason : undefined;
        if (reason?.kind === "error") {
          const failure = isRecord(reason.error) ? reason.error : undefined;
          turnError =
            typeof failure?.message === "string" && failure.message
              ? failure.message
              : "The harness reported a model error.";
        } else if (reason?.kind === "aborted") {
          turnError = "The harness cancelled the turn.";
        } else {
          turnError = undefined;
        }
      }
    },

    finish(): { error?: string } {
      closeText();
      return turnError === undefined ? {} : { error: turnError };
    },
  };
}

/** Concatenated text of harness content blocks, with non-text kinds named rather than dropped. */
function flattenText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text) parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("");
}
