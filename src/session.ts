import type { AgentEvent, AgentSession, Logger, ModelContent } from "@valethq/sdk";
import type { AcpClient } from "./acp";
import { optionValues, resolveModel } from "./models";
import { mapStop, mapUpdate, newUpdateState, type UpdateState } from "./events";

export interface SessionInit {
  client: AcpClient;
  id: string;
  cwd: string;
  model: string;
  mode: string;
  configOptions: unknown;
  reseeded: boolean;
  log: Logger;
  onClose(): void;
}

export class DevinSession implements AgentSession {
  readonly reseeded: boolean;
  private generation: number;
  private interrupted = "";
  private lastUsed?: number;

  constructor(private init: SessionInit) {
    this.reseeded = init.reseeded;
    this.generation = init.client.generation;
  }

  get options(): unknown {
    return this.init.configOptions;
  }

  get resumeId(): string {
    return this.init.id;
  }

  async configure(): Promise<void> {
    const { client, id, mode, model } = this.init;
    await client.request("session/set_mode", { sessionId: id, modeId: mode });
    if (model) await this.applyModel(model);
  }

  private async setOption(configId: string, value: string): Promise<void> {
    const r = await this.init.client.request("session/set_config_option", {
      sessionId: this.init.id,
      configId,
      value,
    });
    if (r.configOptions) this.init.configOptions = r.configOptions;
  }

  private async applyModel(id: string): Promise<void> {
    const resolved = resolveModel(id, { models: optionValues(this.init.configOptions, "model") });
    if (!resolved) throw new Error(`model "${id}" is not available in devin acp`);
    await this.setOption("model", resolved.model);
    if (
      resolved.thoughtLevel &&
      optionValues(this.init.configOptions, "thought_level").includes(resolved.thoughtLevel)
    )
      await this.setOption("thought_level", resolved.thoughtLevel);
    if (optionValues(this.init.configOptions, "speed").length)
      await this.setOption("speed", resolved.speed ?? "standard");
  }

  private async ready(): Promise<void> {
    const { client, id, cwd } = this.init;
    await client.ensure();
    if (this.generation === client.generation) return;
    this.init.configOptions = (await client.loadSession(id, cwd)).configOptions ?? this.init.configOptions;
    this.generation = client.generation;
    await this.configure();
  }

  async setModel(model: string): Promise<void> {
    await this.ready();
    await this.applyModel(model);
    this.init.model = model;
  }

  async close(): Promise<void> {
    this.init.client.unlisten(this.init.id);
    this.init.onClose();
  }

  async *prompt(
    input: { content: ModelContent[]; preamble?: string },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const { client, id } = this.init;
    try {
      await this.ready();
    } catch (e) {
      yield { type: "finish", reason: "error", error: (e as Error).message };
      return;
    }
    const state = newUpdateState(this.init.log, this.lastUsed);
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const push = (e: AgentEvent) => {
      queue.push(e);
      wake?.();
    };
    client.listen(id, (u) => {
      for (const e of mapUpdate(u, state)) push(e);
    });
    const cancel = () => client.notify("session/cancel", { sessionId: id });
    signal.addEventListener("abort", cancel);
    const partial = this.interrupted;
    this.interrupted = "";
    const texts = [
      partial,
      ...(input.preamble?.split(/\n(?=## )/) ?? []),
      ...input.content.map((c) => (c.type === "text" ? c.text : undefined)),
    ];
    const prompt = texts.filter((t): t is string => !!t).map((text) => ({ type: "text", text }));
    client
      .request("session/prompt", { sessionId: id, prompt })
      .then(
        (r) => {
          const usage = (r.usage ?? {}) as Record<string, number>;
          push({
            type: "usage",
            contextTokens: state.contextTokens,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
          if (r.stopReason === "cancelled" || signal.aborted) this.interrupted = partialOutput(state);
          push({ type: "finish", ...mapStop(r.stopReason) });
        },
        (e: Error) => push({ type: "finish", reason: "error", error: e.message }),
      )
      .finally(() => {
        done = true;
        wake?.();
      });
    if (signal.aborted) cancel();
    try {
      while (true) {
        const next = queue.shift();
        if (next) yield next;
        else if (done) return;
        else await new Promise<void>((r) => (wake = r));
      }
    } finally {
      this.lastUsed = state.contextTokens;
      signal.removeEventListener("abort", cancel);
      client.unlisten(id);
    }
  }
}

function partialOutput(state: UpdateState): string {
  const parts = [...state.open].map(
    ([callId, title]) => `${title}:\n${(state.outputs.get(callId) ?? "").slice(-4000)}`,
  );
  return parts.length
    ? `[The previous turn was stopped by the user. Partial output of the interrupted tool call(s) so far:\n${parts.join("\n")}]`
    : "";
}
