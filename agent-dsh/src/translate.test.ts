import { describe, expect, test } from "bun:test";
import {
  type AgUiEvent,
  createRunTranslator,
  messageText,
  planPrompt,
} from "./translate.ts";

describe("planPrompt", () => {
  const standingRole = {
    id: "standing-role:risk",
    role: "system",
    content: "You are Risk Analyst, Risk & Compliance.",
  };

  test("first contact delivers the standing role and the message once", () => {
    const plan = planPrompt({
      messages: [
        standingRole,
        { id: "u1", role: "user", content: "Check the Q3 controls." },
      ],
      sessionIsNew: true,
      seen: new Set(),
    });
    expect(plan.prompt).toContain("Risk Analyst");
    expect(plan.prompt).toContain("Check the Q3 controls.");
    expect(plan.prompt).not.toContain("Earlier conversation");
    expect(plan.seenIds).toEqual(["standing-role:risk", "u1"]);
  });

  test("a later run forwards only what is new, without the scaffolding", () => {
    const plan = planPrompt({
      messages: [
        standingRole,
        { id: "u1", role: "user", content: "Check the Q3 controls." },
        { id: "a1", role: "assistant", content: "Done: two exceptions." },
        { id: "u2", role: "user", content: "List the exceptions." },
      ],
      sessionIsNew: false,
      seen: new Set(["standing-role:risk", "u1", "a1"]),
    });
    expect(plan.prompt).toBe("List the exceptions.");
  });

  test("a new session with prior history gets that history back as a recap", () => {
    const plan = planPrompt({
      messages: [
        standingRole,
        { id: "u1", role: "user", content: "Check the Q3 controls." },
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "bash", arguments: "{}" },
            },
          ],
        },
        { id: "a2", role: "assistant", content: "Done: two exceptions." },
        { id: "u2", role: "user", content: "List the exceptions." },
      ],
      sessionIsNew: true,
      seen: new Set(),
    });
    expect(plan.prompt).toContain(
      "[Earlier conversation, restored by the platform]",
    );
    expect(plan.prompt).toContain("Person: Check the Q3 controls.");
    expect(plan.prompt).toContain("You: (used bash)");
    expect(plan.prompt).toContain("You: Done: two exceptions.");
    // The current input is the trailing message, not part of the recap.
    expect(plan.prompt).toContain("[New message]\nList the exceptions.");
  });

  test("a run with nothing new says nothing", () => {
    const plan = planPrompt({
      messages: [
        standingRole,
        { id: "u1", role: "user", content: "Check the Q3 controls." },
      ],
      sessionIsNew: false,
      seen: new Set(["standing-role:risk", "u1"]),
    });
    expect(plan.prompt).toBeNull();
  });
});

describe("messageText", () => {
  test("keeps text parts and names the parts it drops", () => {
    expect(
      messageText([
        { type: "text", text: "look at this" },
        { type: "image", source: {} },
      ]),
    ).toBe("look at this\n[image attachment omitted]");
  });
});

describe("createRunTranslator", () => {
  const chunk = (text: string) => ({
    type: "assistant/chunk",
    data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text } },
  });
  const committed = (text: string) => ({
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  });

  function collect() {
    const events: AgUiEvent[] = [];
    const translator = createRunTranslator("run1", (event) =>
      events.push(event),
    );
    return { events, translator };
  }

  test("streams text as one open message and closes it on the committed message", () => {
    const { events, translator } = collect();
    translator.onSessionEvent(chunk("Hel"));
    translator.onSessionEvent(chunk("lo"));
    translator.onSessionEvent(committed("Hello"));
    expect(translator.finish()).toEqual({});
    expect(events.map((event) => event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
    const startedId = events[0]?.messageId;
    expect(typeof startedId).toBe("string");
    expect(events.every((event) => event.messageId === startedId)).toBe(true);
  });

  test("a harness tool call becomes a completed call with its result", () => {
    const { events, translator } = collect();
    translator.onSessionEvent(chunk("Running it."));
    translator.onSessionEvent(committed("Running it."));
    translator.onSessionEvent({
      type: "tool/call",
      data: {
        turn: 1,
        step: 1,
        callId: "c9",
        name: "bash",
        arguments: '{"command":"ls"}',
      },
    });
    translator.onSessionEvent({
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: "c9",
              content: [{ type: "text", text: "a.txt" }],
            },
          ],
        },
      },
    });
    translator.finish();
    const types = events.map((event) => event.type);
    expect(types).toContain("TOOL_CALL_START");
    expect(types).toContain("TOOL_CALL_ARGS");
    expect(types).toContain("TOOL_CALL_END");
    expect(types).toContain("TOOL_CALL_RESULT");
    const start = events.find((event) => event.type === "TOOL_CALL_START");
    expect(start?.toolCallName).toBe("bash");
    // The call is parented to the assistant message that made it.
    expect(start?.parentMessageId).toBe(events[0]?.messageId as string);
    const result = events.find((event) => event.type === "TOOL_CALL_RESULT");
    expect(result?.toolCallId).toBe("c9");
    expect(result?.content).toBe("a.txt");
  });

  test("two model steps become two assistant messages", () => {
    const { events, translator } = collect();
    translator.onSessionEvent(chunk("step one"));
    translator.onSessionEvent(committed("step one"));
    translator.onSessionEvent(chunk("step two"));
    translator.onSessionEvent(committed("step two"));
    translator.finish();
    const starts = events.filter(
      (event) => event.type === "TEXT_MESSAGE_START",
    );
    expect(starts.length).toBe(2);
    expect(starts[0]?.messageId).not.toBe(starts[1]?.messageId);
  });

  test("a committed message that never streamed is still delivered", () => {
    const { events, translator } = collect();
    translator.onSessionEvent(committed("Whole answer."));
    translator.finish();
    expect(events.map((event) => event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
    expect(events[1]?.delta).toBe("Whole answer.");
  });

  test("an errored turn is reported after open text is closed", () => {
    const { events, translator } = collect();
    translator.onSessionEvent(chunk("half an ans"));
    translator.onSessionEvent({
      type: "turn/end",
      data: {
        turn: 1,
        reason: {
          kind: "error",
          error: { message: "rate limited", code: "RATE_LIMIT" },
        },
      },
    });
    const outcome = translator.finish();
    expect(outcome.error).toBe("rate limited");
    expect(events.at(-1)?.type).toBe("TEXT_MESSAGE_END");
  });

  test("a completed later turn clears an earlier turn's error", () => {
    const { translator } = collect();
    translator.onSessionEvent({
      type: "turn/end",
      data: {
        turn: 1,
        reason: { kind: "error", error: { message: "x", code: "Y" } },
      },
    });
    translator.onSessionEvent({
      type: "turn/end",
      data: { turn: 2, reason: { kind: "completed" } },
    });
    expect(translator.finish()).toEqual({});
  });

  test("unrecognized events are skipped rather than trusted", () => {
    const { events, translator } = collect();
    translator.onSessionEvent(null);
    translator.onSessionEvent({ type: "todo/write", data: { todos: [] } });
    translator.onSessionEvent({
      type: "assistant/chunk",
      data: { chunk: { type: "usage" } },
    });
    expect(translator.finish()).toEqual({});
    expect(events).toEqual([]);
  });
});
