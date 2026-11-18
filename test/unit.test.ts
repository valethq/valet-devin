import { expect, test } from "bun:test";
import { drainText, mapStop, mapUpdate, newUpdateState } from "../src/events";
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
    { id: "adaptive", name: "Adaptive", contextWindow: 1000000 },
    { id: "swe-2-high", name: "SWE-2 High", contextWindow: 262000 },
    { id: "gemini-x", name: "Gemini X", contextWindow: 1000000 },
  ]);
});

test("parseModels fills unknown windows from non-fusion max", () => {
  const out = [
    "  adaptive  Adaptive  [$1 / 1M Input]",
    "  swe-2-high  SWE-2 High  [262K context, Free]",
    "  fusion-x-sidekick-y  Fusion (X + Y)  [9M context]",
  ].join("\n");
  expect(parseModels(out)).toEqual([
    { id: "adaptive", name: "Adaptive", contextWindow: 262000 },
    { id: "swe-2-high", name: "SWE-2 High", contextWindow: 262000 },
    { id: "fusion-x-sidekick-y", name: "Fusion (X + Y)", contextWindow: 9000000 },
  ]);
  expect(parseModels("  lone  Lone  [$1]")[0]?.contextWindow).toBe(200000);
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

test("tool-end carries terminal exit code", () => {
  const run = (exit_code?: number) => {
    const s = newUpdateState();
    mapUpdate({ sessionUpdate: "tool_call", toolCallId: "1", title: "Ran sh", kind: "execute" }, s);
    mapUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "hi" } }],
        _meta: {
          "cognition.ai/inferenceToolName": "exec",
          ...(exit_code === undefined
            ? {}
            : { terminal_exit: { terminal_id: "t0", exit_code, signal: null } }),
        },
      },
      s,
    );
    return mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed" }, s).at(-1);
  };
  expect(run(3)).toEqual({ type: "tool-end", callId: "1", status: "done", output: "hi", exitCode: 3 });
  expect(run(0)).toEqual({ type: "tool-end", callId: "1", status: "done", output: "hi", exitCode: 0 });
  const none = run();
  expect(none).toEqual({ type: "tool-end", callId: "1", status: "done", output: "hi" });
  expect(none).not.toHaveProperty("exitCode");
});

test("ACP compaction_update opens on in_progress and closes on a terminal status", () => {
  const s = newUpdateState({ debug() {}, info() {}, warn() {}, error() {} }, 1000);
  expect(
    mapUpdate({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" }, s),
  ).toEqual([{ type: "compaction-start" }]);
  expect(
    mapUpdate({ sessionUpdate: "compaction_update", compactionId: "c1", status: "failed", error: "boom" }, s),
  ).toEqual([{ type: "compaction-end", status: "failed", error: "boom" }]);
});

test("usage drop over 30% surfaces a compaction marker", () => {
  const logs: { level: string; msg: string }[] = [];
  const log = (level: string) => (msg: string) => logs.push({ level, msg });
  const s = newUpdateState(
    { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    1000,
  );
  expect(mapUpdate({ sessionUpdate: "usage_update", used: 212200 }, s)).toEqual([
    { type: "usage", contextTokens: 212200 },
  ]);
  expect(mapUpdate({ sessionUpdate: "usage_update", used: 83500 }, s)).toEqual([
    { type: "compaction-start" },
    { type: "compaction-end", status: "completed" },
    { type: "usage", contextTokens: 83500 },
  ]);
  expect(logs).toContainEqual({ level: "info", msg: "devin cli compacted the context" });
  expect(mapUpdate({ sessionUpdate: "usage_update", used: 60000 }, s)).toEqual([
    { type: "usage", contextTokens: 60000 },
  ]);
});

test("update titles log at debug only", () => {
  const logs: { level: string; msg: string; data?: unknown }[] = [];
  const log = (level: string) => (msg: string, data?: Record<string, unknown>) =>
    logs.push({ level, msg, data });
  const s = newUpdateState({
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  });
  expect(mapUpdate({ sessionUpdate: "session_info_update", title: "hello" }, s)).toEqual([]);
  expect(logs).toEqual([
    { level: "debug", msg: "acp update title", data: { update: "session_info_update", title: "hello" } },
  ]);
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

test("modelLister hides fusion and adaptive per current settings", async () => {
  const out = [
    "  adaptive  Adaptive  [$1 / 1M Input]",
    "  swe-2-high  SWE-2 High  [262K context, Free]",
    "  fusion-a-sidekick-b  Fusion (A + B)  [1M context]",
    "  fusion-c-sidekick-d  Fusion (C + D)  [1M context]",
  ].join("\n");
  let hidden = { fusion: true, adaptive: true };
  const list = modelLister(
    {},
    async () => out,
    undefined,
    () => hidden,
  );
  expect((await list()).map((m) => m.id)).toEqual(["swe-2-high"]);
  hidden = { fusion: false, adaptive: true };
  expect((await list()).map((m) => m.id)).toEqual([
    "swe-2-high",
    "fusion-a-sidekick-b",
    "fusion-c-sidekick-d",
  ]);
  hidden = { fusion: true, adaptive: false };
  expect((await list()).map((m) => m.id)).toEqual(["adaptive", "swe-2-high"]);
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
  expect(upd("x")).toEqual([{ type: "tool-update", callId: "1", outputDelta: "\nx" }]);
  expect(upd("ab\nxc", "completed")).toEqual([
    { type: "tool-update", callId: "1", outputDelta: "c" },
    { type: "tool-end", callId: "1", status: "done", output: "ab\nxc" },
  ]);
});

test("failed call status sticks over a later completed update", () => {
  const s = newUpdateState();
  const upd = (status: string, t: string) =>
    mapUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "1",
        status,
        content: [{ type: "content", content: { type: "text", text: t } }],
      },
      s,
    );
  mapUpdate({ sessionUpdate: "tool_call", toolCallId: "1", title: "Run", kind: "execute" }, s);
  upd("in_progress", "tick1\n");
  expect(upd("failed", "Canceled due to user interrupt").at(-1)).toMatchObject({
    type: "tool-end",
    status: "error",
  });
  expect(upd("completed", "tick1\n").at(-1)).toMatchObject({ type: "tool-end", status: "done" });
  expect(s.calls.get("1")).toEqual({ title: "Run", status: "failed" });
  expect(s.outputs.get("1")).toBe("tick1\n\nCanceled due to user interrupt\ntick1\n");
});

const LT = "<" + "|";
const chunkUpd = (sessionUpdate: string, text: string) => ({
  sessionUpdate,
  content: { type: "text", text },
});
const texts = (events: { type: string; text?: string }[]) =>
  events.filter((e) => e.type === "text-delta" || e.type === "reasoning-delta");

test("leaked control tokens are dropped from message text", () => {
  const warns: string[] = [];
  const s = newUpdateState({
    debug: () => {},
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
  });
  const msg = (t: string) => mapUpdate(chunkUpd("agent_message_chunk", t), s);
  const leaked = `mango${LT}close|>argument${LT}sep|>${LT}close|>call${LT}sep|>${LT}close|>tools${LT}sep|>`;
  const chunks = [
    "man",
    `go${LT}clo`,
    "se|>arg",
    `ument${LT}sep|>${LT}close|>call`,
    `${LT}sep|>${LT}close|>tools`,
    `${LT}sep|>`,
  ];
  expect(chunks.join("")).toBe(leaked);
  expect(
    chunks
      .flatMap((c) => texts(msg(c)))
      .map((e) => e.text)
      .join(""),
  ).toBe("mango");
  expect(warns).toEqual(["devin cli leaked control tokens; dropped the rest of the message"]);
});

test("plain angle brackets pass through once disambiguated", () => {
  const s = newUpdateState();
  const msg = (t: string) =>
    texts(mapUpdate(chunkUpd("agent_message_chunk", t), s))
      .map((e) => e.text)
      .join("");
  const parts = ["a <", " b and x <", "| y plus z ", `${LT}nope!`, "trail <"];
  const out =
    parts.map(msg).join("") +
    texts(drainText(s))
      .map((e) => e.text)
      .join("");
  expect(out).toBe(`a < b and x ${LT} y plus z ${LT}nope!trail <`);
});

test("a following tool call unmutes the message stream", () => {
  const s = newUpdateState();
  const msg = (t: string) => texts(mapUpdate(chunkUpd("agent_message_chunk", t), s));
  expect(
    msg(`mango${LT}close|>junk`)
      .map((e) => e.text)
      .join(""),
  ).toBe("mango");
  expect(msg("still muted")).toEqual([]);
  const start = mapUpdate({ sessionUpdate: "tool_call", toolCallId: "1", title: "Run", kind: "execute" }, s);
  expect(start[0]).toMatchObject({ type: "tool-start", callId: "1" });
  expect(
    msg("hi again")
      .map((e) => e.text)
      .join(""),
  ).toBe("hi again");
  expect(
    msg("end <")
      .map((e) => e.text)
      .join(""),
  ).toBe("end ");
  const upd = mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "in_progress" }, s);
  expect(upd[0]).toEqual({ type: "text-delta", text: "<" });
});

test("a chunk flushes the other stream's held text", () => {
  const s = newUpdateState();
  const upd = (u: string, t: string) => mapUpdate(chunkUpd(u, t), s);
  expect(upd("agent_thought_chunk", "hmm <")).toEqual([{ type: "reasoning-delta", text: "hmm " }]);
  expect(upd("agent_message_chunk", "ok")).toEqual([
    { type: "reasoning-delta", text: "<" },
    { type: "text-delta", text: "ok" },
  ]);
  expect(upd("agent_thought_chunk", `r${LT}close|>junk`)).toEqual([{ type: "reasoning-delta", text: "r" }]);
  expect(upd("agent_thought_chunk", "dropped")).toEqual([]);
});

test("modelLister appends custom models and lets one rename a listed model", async () => {
  const list = modelLister(
    {},
    async () => SAMPLE,
    undefined,
    undefined,
    () => [
      { id: "swe-2-high", name: "SWE" },
      { id: "my-model", name: "Mine" },
    ],
  );
  const models = await list();
  expect(models.find((m) => m.id === "swe-2-high")?.name).toBe("SWE");
  expect(models.at(-1)).toMatchObject({ id: "my-model", name: "Mine" });
});
