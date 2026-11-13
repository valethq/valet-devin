import type { AgentEvent, AgentSession, ModelContent } from "@valethq/sdk";
import type { AcpClient } from "./acp";
import { mapStop, mapUpdate, newUpdateState } from "./events";

export interface SessionInit {
  client: AcpClient;
  id: string;
  cwd: string;
  model: string;
  mode: string;
  reseeded: boolean;
  onClose(): void;
}

export class DevinSession implements AgentSession {
  readonly reseeded: boolean;
  private generation: number;

  constructor(private init: SessionInit) {
    this.reseeded = init.reseeded;
    this.generation = init.client.generation;
  }

  get resumeId(): string {
    return this.init.id;
  }

  async configure(): Promise<void> {
    const { client, id, mode, model } = this.init;
    await client.request("session/set_mode", { sessionId: id, modeId: mode });
    if (model)
      await client.request("session/set_config_option", { sessionId: id, configId: "model", value: model });
  }

  private async ready(): Promise<void> {
    const { client, id, cwd } = this.init;
    await client.ensure();
    if (this.generation === client.generation) return;
    await client.loadSession(id, cwd);
    this.generation = client.generation;
    await this.configure();
  }

  async setModel(model: string): Promise<void> {
    await this.ready();
    await this.init.client.request("session/set_config_option", {
      sessionId: this.init.id,
      configId: "model",
      value: model,
    });
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
    const state = newUpdateState();
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
    const texts = [input.preamble, ...input.content.map((c) => (c.type === "text" ? c.text : undefined))];
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
      signal.removeEventListener("abort", cancel);
      client.unlisten(id);
    }
  }
}
