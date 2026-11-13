import type { AgentEvent, Logger } from "@valethq/sdk";

type Obj = Record<string, unknown>;

export interface UpdateState {
  outputs: Map<string, string>;
  open: Map<string, string>;
  contextTokens?: number;
  log?: Logger;
}

export function newUpdateState(log?: Logger, contextTokens?: number): UpdateState {
  return { outputs: new Map(), open: new Map(), log, contextTokens };
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

function chunkText(u: Obj): string {
  const c = u.content as Obj | undefined;
  return c?.type === "text" && typeof c.text === "string" ? c.text : "";
}

function cumulative(callId: string, full: string, state: UpdateState): AgentEvent[] {
  const prev = state.outputs.get(callId) ?? "";
  if (!full) return [];
  state.outputs.set(callId, full);
  const delta = full.startsWith(prev) ? full.slice(prev.length) : "";
  return delta ? [{ type: "tool-update", callId, outputDelta: delta }] : [];
}

function end(callId: string, status: "completed" | "failed", state: UpdateState): AgentEvent {
  state.open.delete(callId);
  return {
    type: "tool-end",
    callId,
    status: status === "completed" ? "done" : "error",
    output: state.outputs.get(callId),
  };
}

export function mapUpdate(u: Obj, state: UpdateState): AgentEvent[] {
  const callId = String(u.toolCallId ?? "");
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const text = chunkText(u);
      return text ? [{ type: "text-delta", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = chunkText(u);
      return text ? [{ type: "reasoning-delta", text }] : [];
    }
    case "tool_call": {
      const title = typeof u.title === "string" ? u.title : undefined;
      const name = typeof u.kind === "string" ? u.kind : (title ?? "tool");
      state.outputs.set(callId, "");
      state.open.set(callId, title ?? name);
      const events: AgentEvent[] = [{ type: "tool-start", callId, name, title, input: u.rawInput }];
      events.push(...cumulative(callId, textOf(u.content), state));
      if (u.status === "completed" || u.status === "failed") events.push(end(callId, u.status, state));
      return events;
    }
    case "tool_call_update": {
      const events = cumulative(callId, textOf(u.content), state);
      if (typeof u.title === "string" && state.open.has(callId)) state.open.set(callId, u.title);
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
        // spec-gap: AgentEvent has no notice/warning type; surface as reasoning-delta
        const text = `[Devin CLI compacted the context: ${k(prev)} → ${k(u.used)} tokens]`;
        state.log?.info("devin cli compacted the context", { from: prev, to: u.used });
        events.push({ type: "reasoning-delta", text });
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

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

export function mapStop(reason: unknown): {
  reason: "stop" | "cancelled" | "length" | "error";
  error?: string;
} {
  if (reason === "end_turn") return { reason: "stop" };
  if (reason === "cancelled") return { reason: "cancelled" };
  if (reason === "max_tokens" || reason === "max_turn_requests") return { reason: "length" };
  return { reason: "error", error: `stop reason: ${String(reason)}` };
}
