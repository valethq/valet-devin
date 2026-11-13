import type { AgentProvider, AgentSession, PluginContext } from "@valethq/sdk";
import { AcpClient } from "./acp";
import { type DevinConfig, spawnCommand } from "./config";
import { modelLister, optionValues } from "./models";
import { DevinSession } from "./session";
import { hideAdaptive, hideFusion, permissionMode } from "./settings";

export const PROVIDER_KEY = "devin-cli";

export function createProvider(ctx: PluginContext<DevinConfig>): {
  provider: AgentProvider;
  dispose(): void;
} {
  const cfg = ctx.config ?? {};
  const client = new AcpClient({ command: spawnCommand(cfg), denyKinds: cfg.denyKinds ?? [], log: ctx.log });
  ctx.onConfigChange((next, prev) => {
    const spawned = (c: DevinConfig) => JSON.stringify([c.command, c.refusalFallback, c.denyKinds]);
    if (spawned(next) !== spawned(prev))
      throw new Error("command, refusalFallback and denyKinds need a restart");
  });
  const sessions = new Set<DevinSession>();
  const acpModels = async () => {
    const live = [...sessions].map((s) => optionValues(s.options, "model")).find((v) => v.length);
    if (live) return live;
    const r = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    return optionValues(r.configOptions, "model");
  };

  const provider: AgentProvider = {
    kind: "agent",
    id: PROVIDER_KEY,
    label: "Devin CLI",
    listModels: modelLister(
      {
        get models() {
          return ctx.config?.models;
        },
      },
      undefined,
      acpModels,
      () => ({ fusion: hideFusion(ctx), adaptive: hideAdaptive(ctx) }),
    ),
    async open(opts): Promise<AgentSession> {
      const session = ctx.store.sessions.get(opts.sessionId);
      const project = session && ctx.store.projects.get(session.projectId);
      const cwd = project?.workspaceDir ?? opts.cwd;
      await client.ensure();
      let id: string | undefined;
      let configOptions: unknown;
      if (opts.resumeId && client.loadSupported) {
        try {
          configOptions = (await client.loadSession(opts.resumeId, cwd)).configOptions;
          id = opts.resumeId;
        } catch (e) {
          ctx.log.warn("session/load failed, reseeding", { resumeId: opts.resumeId, error: String(e) });
        }
      }
      if (!id) {
        const r = await client.request("session/new", { cwd, mcpServers: [] });
        id = String(r.sessionId);
        configOptions = r.configOptions;
      }
      const devin: DevinSession = new DevinSession({
        client,
        id,
        cwd,
        model: opts.model,
        configOptions,
        mode: permissionMode(ctx),
        reseeded: id !== opts.resumeId && opts.resumeId !== undefined,
        log: ctx.log,
        blobPath: (blobId) => ctx.store.blobs.path(blobId),
        onClose: () => sessions.delete(devin),
      });
      await devin.configure();
      sessions.add(devin);
      ctx.store.sessions.setProviderState(opts.sessionId, PROVIDER_KEY, { resumeId: id });
      return devin;
    },
  };
  return { provider, dispose: () => client.dispose() };
}
