import { expect, test } from "bun:test";
import { mapStop, mapUpdate, newUpdateState } from "../src/events";
import { modelLister, parseModels, resolveModel } from "../src/models";

const SAMPLE = `Available models (51 families)

Adaptive (adaptive)
  adaptive      Adaptive  [$0.5 / 1M Input]

SWE-2 (swe-2)
  aliases: swe
  swe-2-high      SWE-2 High  [262K context, Free]
  gemini-x        Gemini X  [1M context, $1 / 1M Input]
or switch models in a session with \`/model <name>\`.
`;

test("parseModels", () => {
  expect(parseModels(SAMPLE)).toEqual([
    { id: "adaptive", name: "Adaptive", contextWindow: 200000 },
    { id: "swe-2-high", name: "SWE-2 High", contextWindow: 262000 },
    { id: "gemini-x", name: "Gemini X", contextWindow: 1000000 },
  ]);
});

test("modelLister caches and falls back", async () => {
  let runs = 0;
  const list = modelLister({}, async () => {
    runs++;
    return SAMPLE;
  });
  await list();
  expect((await list()).map((m) => m.id)).toContain("swe-2-high");
  expect(runs).toBe(1);
  const fallback = await modelLister({ models: [{ id: "x", contextWindow: 5 }] }, async () => {
    throw new Error("no devin");
  })();
  expect(fallback).toMatchObject([{ id: "x", name: "x", contextWindow: 5 }]);
  expect((await modelLister({}, async () => "")()).map((m) => m.id)).toContain("claude-fable-5-2-medium");
});

test("mapUpdate", () => {
  const s = newUpdateState();
  const chunk = (sessionUpdate: string) => ({ sessionUpdate, content: { type: "text", text: "hi" } });
  expect(mapUpdate(chunk("agent_message_chunk"), s)).toEqual([{ type: "text-delta", text: "hi" }]);
  expect(mapUpdate(chunk("agent_thought_chunk"), s)).toEqual([{ type: "reasoning-delta", text: "hi" }]);
  expect(mapUpdate(chunk("user_message_chunk"), s)).toEqual([]);
  expect(
    mapUpdate(
      { sessionUpdate: "tool_call", toolCallId: "1", title: "Run", kind: "execute", rawInput: { a: 1 } },
      s,
    ),
  ).toEqual([{ type: "tool-start", callId: "1", name: "execute", title: "Run", input: { a: 1 } }]);
  const text = (t: string) => [{ type: "content", content: { type: "text", text: t } }];
  expect(
    mapUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "1", status: "in_progress", content: text("a") },
      s,
    ),
  ).toEqual([
    { type: "tool-update", callId: "1", outputDelta: "a" },
    { type: "tool-update", callId: "1", status: "running" },
  ]);
  expect(
    mapUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed", content: text("ab") },
      s,
    ),
  ).toEqual([
    { type: "tool-update", callId: "1", outputDelta: "b" },
    { type: "tool-end", callId: "1", status: "done", output: "ab" },
  ]);
  expect(
    mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "failed" }, s),
  ).toMatchObject([{ type: "tool-end", status: "error" }]);
  expect(mapUpdate({ sessionUpdate: "usage_update", used: 7, size: 9 }, s)).toEqual([
    { type: "usage", contextTokens: 7 },
  ]);
  expect(s.contextTokens).toBe(7);
  expect(mapUpdate({ sessionUpdate: "session_info_update", title: "t" }, s)).toEqual([]);
});

test("mapStop", () => {
  expect(mapStop("end_turn")).toEqual({ reason: "stop" });
  expect(mapStop("cancelled")).toEqual({ reason: "cancelled" });
  expect(mapStop("max_tokens")).toEqual({ reason: "length" });
  expect(mapStop("refusal").reason).toBe("error");
});

const ACP = ["swe-2-high", "claude-opus-5-5-medium", "gpt-6-sol-medium", "glm-5-2"];

test("resolveModel", () => {
  const r = (id: string) => resolveModel(id, { models: ACP });
  expect(r("swe-2-high")).toEqual({ model: "swe-2-high" });
  expect(r("claude-opus-5-5-low")).toEqual({ model: "claude-opus-5-5-medium", thoughtLevel: "low" });
  expect(r("swe-2-medium-lightning")).toEqual({ model: "swe-2-high", thoughtLevel: "medium", speed: "fast" });
  expect(r("glm-5-2-high-fast-priority")).toEqual({ model: "glm-5-2", thoughtLevel: "high", speed: "fast" });
  expect(r("gpt-6-sol-max")).toEqual({ model: "gpt-6-sol-medium", thoughtLevel: "max" });
  expect(r("unknown-low")).toBeNull();
});

test("modelLister filters to ACP-resolvable ids", async () => {
  const out = "  swe-2-low  A  [1K context]\n  nope-high  B  [1K context]\n  glm-5-2-fast  C  [1K context]\n";
  const ids = async (acp: () => Promise<string[] | undefined>) =>
    (await modelLister({}, async () => out, acp)()).map((m) => m.id);
  expect(await ids(async () => ACP)).toEqual(["swe-2-low", "glm-5-2-fast"]);
  expect(await ids(async () => undefined)).toHaveLength(3);
});

test("cumulative tool output", () => {
  const s = newUpdateState();
  const upd = (t: string, status?: string) =>
    mapUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "1",
        status,
        content: [{ type: "content", content: { type: "text", text: t } }],
      },
      s,
    );
  expect(upd("a")).toEqual([{ type: "tool-update", callId: "1", outputDelta: "a" }]);
  expect(upd("ab")).toEqual([{ type: "tool-update", callId: "1", outputDelta: "b" }]);
  expect(upd("x")).toEqual([]);
  expect(upd("abc", "completed")).toEqual([{ type: "tool-end", callId: "1", status: "done", output: "abc" }]);
});
