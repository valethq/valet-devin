import { afterAll, expect, test } from "bun:test";
import { AcpClient } from "../src/acp";
import { calls, collect, fakeConfig, fakeCtx, input } from "./helpers";

const noop = () => {};
const fakeCtxLog = { debug: noop, info: noop, warn: noop, error: noop };
const disposers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const d of disposers) await d();
});

function setup(extra = {}) {
  const { cfg, logFile } = fakeConfig(extra);
  const h = fakeCtx(cfg);
  disposers.push(h.dispose);
  const open = (o: { resumeId?: string; model?: string } = {}) =>
    h.provider.open({
      sessionId: "s1",
      cwd: "/x",
      model: "",
      mcpServers: [],
      signal: new AbortController().signal,
      ...o,
    });
  return { ...h, logFile, open };
}

test("open, prompt maps events, setModel", async () => {
  const { open, state, logFile } = setup();
  const s = await open({ model: "swe-2-high" });
  expect(state["s1:devin-cli"]).toEqual({ resumeId: s.resumeId });
  const events = await collect(s.prompt(input("ping"), new AbortController().signal));
  expect(events.map((e) => e.type)).toEqual([
    "reasoning-delta",
    "tool-start",
    "tool-update",
    "tool-update",
    "tool-update",
    "tool-end",
    "usage",
    "text-delta",
    "usage",
    "finish",
  ]);
  expect(events.find((e) => e.type === "tool-end")).toMatchObject({ callId: "c1", exitCode: 0 });
  expect(events.at(-2)).toEqual({ type: "usage", contextTokens: 1234, inputTokens: 10, outputTokens: 5 });
  expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  await s.setModel?.("gpt-x-high-fast");
  await expect(s.setModel?.("nope")).rejects.toThrow('model "nope" is not available in devin acp');
  const c = calls(logFile);
  expect(c.find((x) => x.method === "session/new")?.params).toEqual({ cwd: "/tmp", mcpServers: [] });
  expect(c.find((x) => x.method === "session/set_mode")?.params.modeId).toBe("accept-edits");
  expect(c.filter((x) => x.method === "session/set_config_option").map((x) => x.params.value)).toEqual([
    "swe-2-high",
    "standard",
    "gpt-x",
    "high",
    "fast",
  ]);
  await s.close();
});

test("resume swallows replay; failed load reseeds", async () => {
  const { open } = setup({ permissionMode: "plan" });
  const first = await open();
  const resumed = await open({ resumeId: first.resumeId });
  expect(resumed.resumeId).toBe(first.resumeId);
  expect((resumed as { reseeded?: boolean }).reseeded).toBe(false);
  const events = await collect(resumed.prompt(input("hi"), new AbortController().signal));
  expect(events.some((e) => e.type === "text-delta" && e.text === "REPLAYED")).toBe(false);
  const fresh = await open({ resumeId: "gone" });
  expect(fresh.resumeId).not.toBe("gone");
  expect((fresh as { reseeded?: boolean }).reseeded).toBe(true);
});

test("permission policy", async () => {
  const text = async (extra: object) => {
    const s = await setup(extra).open();
    const ev = await collect(s.prompt(input("perm"), new AbortController().signal));
    return ev.find((e) => e.type === "text-delta");
  };
  expect(await text({})).toMatchObject({ text: "permission:a" });
  expect(await text({ denyKinds: ["execute"] })).toMatchObject({ text: "permission:r" });
});

test("cancel", async () => {
  const s = await setup().open();
  const ac = new AbortController();
  const p = collect(s.prompt(input("slow"), ac.signal));
  await Bun.sleep(200);
  ac.abort();
  expect((await p).at(-1)).toEqual({ type: "finish", reason: "cancelled" });
});

test("process exit fails prompt, then restarts with reload", async () => {
  const { open, logFile } = setup();
  const s = await open();
  const events = await collect(s.prompt(input("crash"), new AbortController().signal));
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  const again = await collect(s.prompt(input("ping"), new AbortController().signal));
  expect(again.at(-1)).toEqual({ type: "finish", reason: "stop" });
  expect(calls(logFile).filter((x) => x.method === "session/load")).toHaveLength(1);
}, 15_000);

test("stop carries partial tool output into the next prompt", async () => {
  const { open, logFile } = setup();
  const s = await open();
  const ac = new AbortController();
  const p = collect(s.prompt(input("partial"), ac.signal));
  await Bun.sleep(300);
  ac.abort();
  const events = await p;
  expect(
    events.filter((e) => e.type === "tool-update").map((e) => (e as { outputDelta?: string }).outputDelta),
  ).toEqual([
    "tick1\n",
    undefined,
    "tick2\n",
    undefined,
    "\nCanceled due to user interrupt",
    "\ntick1\ntick2\n",
  ]);
  expect(events.filter((e) => e.type === "tool-end")).toEqual([
    {
      type: "tool-end",
      callId: "p1",
      status: "error",
      output: "tick1\ntick2\n\nCanceled due to user interrupt",
    },
    {
      type: "tool-end",
      callId: "p1",
      status: "done",
      output: "tick1\ntick2\n\nCanceled due to user interrupt\ntick1\ntick2\n",
    },
  ]);
  await collect(s.prompt(input("ping"), new AbortController().signal));
  await collect(s.prompt(input("ping"), new AbortController().signal));
  const sent = calls(logFile)
    .filter((x) => x.method === "session/prompt")
    .map((x) => (x.params.prompt as { text: string }[]).map((b) => b.text));
  expect(sent[1]?.[0]).toBe(
    "[The previous turn was stopped by the user. Partial output of the interrupted tool call(s) so far:\nSleep:\ntick1\ntick2\n\nCanceled due to user interrupt\ntick1\ntick2\n]",
  );
  expect(sent[1]?.[0]).toContain("tick2");
  expect(sent[1]?.[1]).toBe("ping");
  expect(sent[2]).toEqual(["ping"]);
});

test("compaction surfaces a visible notice and info log", async () => {
  const { open, logs } = setup();
  const s = await open();
  const events = await collect(s.prompt(input("compact"), new AbortController().signal));
  expect(events.slice(0, 3)).toEqual([
    { type: "usage", contextTokens: 212200 },
    {
      type: "notice",
      level: "info",
      text: "Context compacted by Devin CLI: 212.2k → 83.5k tokens",
    },
    { type: "usage", contextTokens: 83500 },
  ]);
  expect(logs).toContainEqual({
    level: "info",
    msg: "devin cli compacted the context",
    data: { from: 212200, to: 83500 },
  });
  expect(logs).toContainEqual({
    level: "debug",
    msg: "acp update title",
    data: { update: "session_info_update", title: "fake session" },
  });
});

test("preamble file sections are sent as separate blocks", async () => {
  const { open, logFile } = setup();
  const s = await open();
  await collect(
    s.prompt(
      { ...input("go"), preamble: "context\n## a.ts\nfoo\n## b.ts\nbar" },
      new AbortController().signal,
    ),
  );
  const sent = calls(logFile)
    .filter((x) => x.method === "session/prompt")
    .map((x) => (x.params.prompt as { text: string }[]).map((b) => b.text));
  expect(sent.at(-1)).toEqual(["context", "## a.ts\nfoo", "## b.ts\nbar", "go"]);
});

test("rpc errors carry data", async () => {
  const { cfg } = fakeConfig();
  const client = new AcpClient({ command: cfg.command as string[], denyKinds: [], log: fakeCtxLog });
  disposers.push(async () => client.dispose());
  const { sessionId } = await client.request("session/new", { cwd: "/tmp", mcpServers: [] });
  await expect(
    client.request("session/set_config_option", { sessionId, configId: "model", value: "x" }),
  ).rejects.toThrow("Invalid params: Invalid value 'x' for config option 'model'");
});
