import type { AgentEvent, Logger } from "@valethq/sdk";
import { feed, flush, newTokenFilter, type TokenFilter } from "./control-tokens";

type Obj = Record<string, unknown>;

export interface UpdateState {
  outputs: Map<string, string>;
  calls: Map<string, { title: string; status: "open" | "completed" | "failed"; exitCode?: number }>;
  text: TokenFilter;
  thought: TokenFilter;
  contextTokens?: number;
  log?: Logger;
}

export function newUpdateState(log?: Logger, contextTokens?: number): UpdateState {
  return {
    outputs: new Map(),
    calls: new Map(),
    text: newTokenFilter(),
    thought: newTokenFilter(),
    log,
    contextTokens,
  };
}

function textOf(content: unknown): string {
  const items = Array.isArray(content) ? (content as Obj[]) : [];
  return items
    .map((c) => {
      const inner = (c.type === "content" ? c.content : c) as Obj | undefined;
      return inner?.type === "text" && typeof inner.text === "string" ? inner.text : "";
    })
    .join("");
}

// Observed live: devin acp reports the exit code on a tool_call_update while the
// call is still "in_progress", one update before the final completed/failed one:
//   {"sessionUpdate":"tool_call_update","toolCallId":"call_RjRV...","status":"in_progress",
//    "content":[{"type":"content","content":{"type":"text","text":"hi"}}],
//    "_meta":{"cognition.ai/inferenceToolName":"exec",
//             "terminal_exit":{"terminal_id":"e3f9c9","exit_code":3,"signal":null}}}
// The closing update itself has no payload:
//   {"sessionUpdate":"tool_call_update","toolCallId":"call_RjRV...","status":"completed",
//    "_meta":{"cognition.ai/inferenceToolName":"exec"}}
function exitCodeOf(u: Obj): number | undefined {
  const t = ((u._meta ?? {}) as Obj).terminal_exit as Obj | undefined;
  return typeof t?.exit_code === "number" ? t.exit_code : undefined;
}

function chunkText(u: Obj): string {
  const c = u.content as Obj | undefined;
  return c?.type === "text" && typeof c.text === "string" ? c.text : "";
}

function cumulative(callId: string, full: string, state: UpdateState): AgentEvent[] {
  const prev = state.outputs.get(callId) ?? "";
  if (!full) return [];
  const delta = prev && !full.startsWith(prev) ? `\n${full}` : full.slice(prev.length);
  state.outputs.set(callId, prev + delta);
  return delta ? [{ type: "tool-update", callId, outputDelta: delta }] : [];
}

function end(callId: string, status: "completed" | "failed", state: UpdateState): AgentEvent {
  const c = state.calls.get(callId);
  if (c && c.status !== "failed") c.status = status;
  return {
    type: "tool-end",
    callId,
    status: status === "completed" ? "done" : "error",
    output: state.outputs.get(callId),
    ...(c?.exitCode === undefined ? {} : { exitCode: c.exitCode }),
  };
}

function drained(f: TokenFilter, type: "text-delta" | "reasoning-delta"): AgentEvent[] {
  const text = flush(f);
  return text ? [{ type, text }] : [];
}

// Emit any text held back for token disambiguation, e.g. at turn end.
export function drainText(state: UpdateState): AgentEvent[] {
  return [...drained(state.text, "text-delta"), ...drained(state.thought, "reasoning-delta")];
}

export function mapUpdate(u: Obj, state: UpdateState): AgentEvent[] {
  const callId = String(u.toolCallId ?? "");
  const leaked = () => state.log?.warn("devin cli leaked control tokens; dropped the rest of the message");
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const events = drained(state.thought, "reasoning-delta");
      const text = feed(state.text, chunkText(u), leaked);
      if (text) events.push({ type: "text-delta", text });
      return events;
    }
    case "agent_thought_chunk": {
      const events = drained(state.text, "text-delta");
      const text = feed(state.thought, chunkText(u), leaked);
      if (text) events.push({ type: "reasoning-delta", text });
      return events;
    }
    case "tool_call": {
      const events = drainText(state);
      const title = typeof u.title === "string" ? u.title : undefined;
      const name = typeof u.kind === "string" ? u.kind : (title ?? "tool");
      state.outputs.set(callId, "");
      state.calls.set(callId, { title: title ?? name, status: "open", exitCode: exitCodeOf(u) });
      events.push({ type: "tool-start", callId, name, title, input: u.rawInput });
      events.push(...cumulative(callId, textOf(u.content), state));
      if (u.status === "completed" || u.status === "failed") events.push(end(callId, u.status, state));
      return events;
    }
    case "tool_call_update": {
      const events = drainText(state);
      events.push(...cumulative(callId, textOf(u.content), state));
      const c = state.calls.get(callId) ?? { title: "tool", status: "open" as const };
      state.calls.set(callId, c);
      if (typeof u.title === "string" && c.status === "open") c.title = u.title;
      const exitCode = exitCodeOf(u);
      if (exitCode !== undefined) c.exitCode = exitCode;
      if (u.status === "in_progress") events.push({ type: "tool-update", callId, status: "running" });
      if (u.status === "completed" || u.status === "failed") events.push(end(callId, u.status, state));
      return events;
    }
    case "usage_update": {
      if (typeof u.used !== "number") return [];
      const prev = state.contextTokens;
      state.contextTokens = u.used;
      const events: AgentEvent[] = [];
      if (prev !== undefined && u.used < prev * 0.7) {
        state.log?.info("devin cli compacted the context", { from: prev, to: u.used });
        events.push({ type: "compaction" });
      }
      events.push({ type: "usage", contextTokens: u.used });
      return events;
    }
    default:
      if (typeof u.title === "string")
        state.log?.debug("acp update title", { update: u.sessionUpdate, title: u.title });
      return [];
  }
}

export function mapStop(reason: unknown): {
  reason: "stop" | "cancelled" | "length" | "error";
  error?: string;
} {
  if (reason === "end_turn") return { reason: "stop" };
  if (reason === "cancelled") return { reason: "cancelled" };
  if (reason === "max_tokens" || reason === "max_turn_requests") return { reason: "length" };
  return { reason: "error", error: `stop reason: ${String(reason)}` };
}
