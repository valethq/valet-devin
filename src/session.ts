import type { AgentEvent, AgentSession, Logger, ModelContent, ModelOptions } from "@valethq/sdk";
import type { AcpClient } from "./acp";
import { asEffort, optionValues, toAcp } from "./models";
import { drainText, mapStop, mapUpdate, newUpdateState, type UpdateState } from "./events";

export interface SessionInit {
  client: AcpClient;
  id: string;
  cwd: string;
  model: string;
  effort?: string;
  fast?: boolean;
  mode: string;
  configOptions: unknown;
  reseeded: boolean;
  /** ACP MCP servers the session was opened with; reloads after a child restart pass them again. */
  mcpServers: Record<string, unknown>[];
  log: Logger;
  blobPath(id: string): string;
  onClose(): void;
}

type Block = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

export class DevinSession implements AgentSession {
  readonly reseeded: boolean;
  private generation: number;
  private interrupted = "";
  private lastUsed?: number;
  private effort?: string;
  private fast?: boolean;

  constructor(private init: SessionInit) {
    this.reseeded = init.reseeded;
    this.generation = init.client.generation;
    this.effort = asEffort(init.effort) ?? init.effort;
    this.fast = init.fast;
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
    if (model) await this.applyModel(model, { effort: this.effort, fast: this.fast });
  }

  private async setOption(configId: string, value: string): Promise<void> {
    const r = await this.init.client.request("session/set_config_option", {
      sessionId: this.init.id,
      configId,
      value,
    });
    if (r.configOptions) this.init.configOptions = r.configOptions;
  }

  private async applyModel(id: string, options: ModelOptions): Promise<void> {
    const acpModels = optionValues(this.init.configOptions, "model");
    const extras = {
      ...(options.effort ? { thoughtLevel: options.effort } : {}),
      ...(options.fast === true
        ? { speed: "fast" as const }
        : options.fast === false
          ? { speed: "standard" as const }
          : {}),
    };
    // Unknown ids pass through for valet-agent catalog customs; ACP rejects ones it does not take.
    const resolved = toAcp(id, options, acpModels) ?? { model: id, ...extras };
    try {
      await this.setOption("model", resolved.model);
    } catch {
      throw new Error(`model "${id}" is not available in devin acp`);
    }
    if (
      resolved.thoughtLevel &&
      optionValues(this.init.configOptions, "thought_level").includes(resolved.thoughtLevel)
    )
      await this.setOption("thought_level", resolved.thoughtLevel);
    if (resolved.speed && optionValues(this.init.configOptions, "speed").length)
      await this.setOption("speed", resolved.speed);
  }

  private async ready(): Promise<void> {
    const { client, id, cwd } = this.init;
    await client.ensure();
    if (this.generation === client.generation) return;
    this.init.configOptions =
      (await client.loadSession(id, cwd, this.init.mcpServers)).configOptions ?? this.init.configOptions;
    this.generation = client.generation;
    await this.configure();
  }

  async setModel(model: string, options: ModelOptions): Promise<void> {
    await this.ready();
    this.effort = asEffort(options.effort) ?? options.effort;
    this.fast = options.fast;
    await this.applyModel(model, { effort: this.effort, fast: this.fast });
    this.init.model = model;
  }

  async close(): Promise<void> {
    this.init.client.unlisten(this.init.id);
    this.init.client.unguard(this.init.id);
    this.init.onClose();
  }

  private async promptBlocks(input: { content: ModelContent[]; preamble?: string }): Promise<Block[]> {
    const partial = this.interrupted;
    this.interrupted = "";
    const head = [partial, ...(input.preamble?.split(/\n(?=## )/) ?? [])];
    const content = await Promise.all(input.content.map((c) => this.contentBlock(c)));
    return [
      ...head.filter((t) => !!t).map((text): Block => ({ type: "text", text })),
      ...content.filter((b): b is Block => b !== undefined),
    ];
  }

  private async contentBlock(c: ModelContent): Promise<Block | undefined> {
    if (c.type === "text") return { type: "text", text: c.text };
    if (c.type !== "image") return undefined;
    if (!this.init.client.imageSupported) {
      return { type: "text", text: "[image not sent: Devin CLI does not accept images]" };
    }
    const bytes = await Bun.file(this.init.blobPath(c.blobId)).bytes();
    return { type: "image", mimeType: c.mime, data: Buffer.from(bytes).toString("base64") };
  }

  async *prompt(
    input: { content: ModelContent[]; preamble?: string },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    let blocks: Block[];
    try {
      await this.ready();
      blocks = await this.promptBlocks(input);
    } catch (e) {
      yield { type: "finish", reason: "error", error: (e as Error).message };
      return;
    }
    yield* this.turn(blocks, signal);
  }

  /** `/compact` goes through the same session/prompt; Devin reports the compaction in the turn's updates. */
  async *compact(instructions: string | undefined, signal: AbortSignal): AsyncIterable<AgentEvent> {
    try {
      await this.ready();
    } catch (e) {
      yield { type: "finish", reason: "error", error: (e as Error).message };
      return;
    }
    yield* this.turn(
      [{ type: "text", text: instructions ? `/compact ${instructions}` : "/compact" }],
      signal,
    );
  }

  private async *turn(blocks: Block[], signal: AbortSignal): AsyncIterable<AgentEvent> {
    const { client, id } = this.init;
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
    client
      .request("session/prompt", { sessionId: id, prompt: blocks })
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
          for (const e of drainText(state)) push(e);
          push({ type: "finish", ...mapStop(r.stopReason) });
        },
        (e: Error) => {
          for (const ev of drainText(state)) push(ev);
          push({ type: "finish", reason: "error", error: e.message });
        },
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
  const parts = [...state.calls]
    .filter(([, c]) => c.status !== "completed")
    .map(([callId, c]) => `${c.title}:\n${(state.outputs.get(callId) ?? "").slice(-4000)}`);
  return parts.length
    ? `[The previous turn was stopped by the user. Partial output of the interrupted tool call(s) so far:\n${parts.join("\n")}]`
    : "";
}
