import { appendFileSync } from "node:fs";

const logFile = process.argv[process.argv.indexOf("--log") + 1];
// biome-ignore lint/suspicious/noExplicitAny: loose JSON in a test fixture
type Msg = any;
const waiters = new Map<string, () => void>();
const permWaiters = new Map<number, (r: Msg) => void>();
let seq = 0;
let reqId = 1000;

const opt = (id: string, values: string[]) => ({
  id,
  type: "select",
  currentValue: values[0],
  options: [{ group: "g", options: values.map((value) => ({ value, name: value })) }],
});
const configOptions = () => [
  opt("model", ["swe-2-high", "claude-opus-5-5-medium", "gpt-x"]),
  opt("thought_level", ["low", "medium", "high"]),
  opt("speed", ["standard", "fast"]),
];

const out = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);
const reply = (id: unknown, result: object) => out({ jsonrpc: "2.0", id, result });
const update = (sessionId: string, u: object) =>
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const text = (sessionId: string, kind: string, t: string) =>
  update(sessionId, { sessionUpdate: kind, content: { type: "text", text: t } });
const log = (m: Msg) => logFile && appendFileSync(logFile, `${JSON.stringify(m)}\n`);

async function prompt(id: unknown, p: Msg) {
  const sid = p.sessionId as string;
  const input = p.prompt.map((b: Msg) => b.text).join(" ");
  const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, totalTokens: 15 };
  out({ jsonrpc: "2.0", method: "_cognition.ai/noise", params: {} });
  if (input.includes("crash")) process.exit(1);
  if (input.includes("partial")) {
    update(sid, { sessionUpdate: "tool_call", toolCallId: "p1", title: "Sleep", kind: "execute" });
    for (const t of ["tick1\n", "tick1\ntick2\n"]) {
      update(sid, {
        sessionUpdate: "tool_call_update",
        toolCallId: "p1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: t } }],
      });
    }
    await new Promise<void>((r) => waiters.set(sid, r));
    // live devin acp order on cancel: failed ("Canceled..."), then completed with captured output
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "p1",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "Canceled due to user interrupt" } }],
    });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "p1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "tick1\ntick2\n" } }],
    });
    return reply(id, { stopReason: "cancelled", usage });
  }
  if (input.includes("slow")) {
    text(sid, "agent_message_chunk", "working");
    await new Promise<void>((r) => waiters.set(sid, r));
    return reply(id, { stopReason: "cancelled", usage });
  }
  if (input.includes("perm")) {
    const rid = reqId++;
    out({
      jsonrpc: "2.0",
      id: rid,
      method: "session/request_permission",
      params: {
        sessionId: sid,
        toolCall: { toolCallId: "t1", kind: "execute", title: "ls" },
        options: [
          { optionId: "a", kind: "allow_once", name: "Allow" },
          { optionId: "r", kind: "reject_once", name: "Reject" },
        ],
      },
    });
    const res = await new Promise<Msg>((r) => permWaiters.set(rid, r));
    text(sid, "agent_message_chunk", `permission:${res.result.outcome.optionId}`);
    return reply(id, { stopReason: "end_turn", usage });
  }
  if (input.includes("compact")) {
    update(sid, { sessionUpdate: "session_info_update", title: "fake session" });
    update(sid, { sessionUpdate: "usage_update", used: 212200, size: 262000 });
    update(sid, { sessionUpdate: "usage_update", used: 83500, size: 262000 });
    text(sid, "agent_message_chunk", "ok");
    return reply(id, { stopReason: "end_turn", usage });
  }
  update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  update(sid, {
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "Run",
    kind: "execute",
    rawInput: { cmd: "ls" },
  });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" });
  update(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "files" } }],
  });
  update(sid, { sessionUpdate: "usage_update", used: 1234, size: 200000 });
  text(sid, "agent_message_chunk", input.includes("ping") ? "pong" : "ok");
  reply(id, { stopReason: "end_turn", usage });
}

async function handle(m: Msg) {
  if (m.method === undefined) return permWaiters.get(m.id)?.(m);
  log({ method: m.method, params: m.params });
  const { id, params } = m;
  switch (m.method) {
    case "initialize":
      return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    case "session/new":
      return reply(id, {
        sessionId: `fake-${++seq}-${Date.now()}`,
        modes: {},
        configOptions: configOptions(),
      });
    case "session/load":
      if (!String(params.sessionId).startsWith("fake-")) {
        return out({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown session" } });
      }
      text(params.sessionId, "agent_message_chunk", "REPLAYED");
      text(params.sessionId, "user_message_chunk", "REPLAYED");
      return reply(id, { configOptions: configOptions() });
    case "session/set_mode":
      return reply(id, { configOptions: configOptions() });
    case "session/set_config_option": {
      const values = configOptions()
        .find((o) => o.id === params.configId)
        ?.options[0]?.options.map((o) => o.value);
      if (!values?.includes(params.value)) {
        const data = `Invalid value '${params.value}' for config option '${params.configId}'`;
        return out({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params", data } });
      }
      return reply(id, { configOptions: configOptions() });
    }
    case "session/prompt":
      return prompt(id, params);
    case "session/cancel":
      return waiters.get(params.sessionId)?.();
    default:
      if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
}
