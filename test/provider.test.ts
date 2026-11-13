import { afterAll, expect, test } from "bun:test";
import { calls, collect, fakeConfig, fakeCtx, input } from "./helpers";

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
    "tool-end",
    "usage",
    "text-delta",
    "usage",
    "finish",
  ]);
  expect(events.at(-2)).toEqual({ type: "usage", contextTokens: 1234, inputTokens: 10, outputTokens: 5 });
  expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  await s.setModel?.("gpt-x");
  const c = calls(logFile);
  expect(c.find((x) => x.method === "session/new")?.params).toEqual({ cwd: "/tmp", mcpServers: [] });
  expect(c.find((x) => x.method === "session/set_mode")?.params.modeId).toBe("accept-edits");
  expect(c.filter((x) => x.method === "session/set_config_option").map((x) => x.params.value)).toEqual([
    "swe-2-high",
    "gpt-x",
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
