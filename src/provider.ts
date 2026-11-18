import {
  type AgentProvider,
  type AgentSession,
  type McpServerEntry,
  type PluginContext,
  toolEndpoint,
} from "@valethq/sdk";
import { AcpClient } from "./acp";
import { type DevinConfig, spawnCommand } from "./config";
import { modelLister, optionValues } from "./models";
import { DevinSession } from "./session";
import { hideAdaptive, hideFusion, permissionMode } from "./settings";
import { createUtility } from "./utility";

export const PROVIDER_KEY = "devin-cli";

/** ACP's shape for an HTTP MCP server (`mcpCapabilities.http` on initialize). */
export const acpMcpServer = (e: McpServerEntry): Record<string, unknown> => ({
  type: "http",
  name: e.name,
  url: e.url,
  headers: Object.entries(e.headers).map(([name, value]) => ({ name, value })),
});

export function createProvider(ctx: PluginContext<DevinConfig>): {
  provider: AgentProvider;
  dispose(): void;
} {
  const cfg = () => ctx.config ?? {};
  const client = new AcpClient({
    command: spawnCommand(cfg()),
    denyKinds: cfg().denyKinds ?? [],
    log: ctx.log,
  });
  ctx.onConfigChange((next, prev) => {
    const spawned = (c: DevinConfig) => JSON.stringify([c.command, c.refusalFallback, c.denyKinds]);
    if (spawned(next) !== spawned(prev))
      throw new Error("command, refusalFallback and denyKinds need a restart");
  });
  const sessions = new Set<DevinSession>();
  const tools = toolEndpoint(ctx.http, {
    serverName: "valet",
    version: ctx.plugin.version,
    readBlob: (blobId) => Bun.file(ctx.store.blobs.path(blobId)).bytes(),
  });
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
    listModels: modelLister(cfg, undefined, acpModels, () => ({
      fusion: hideFusion(ctx),
      adaptive: hideAdaptive(ctx),
    })),
    utility: createUtility(ctx, client),
    async open(opts): Promise<AgentSession> {
      const session = ctx.store.sessions.get(opts.sessionId);
      const project = session && ctx.store.projects.get(session.projectId);
      const cwd = project?.workspaceDir ?? opts.cwd;
      await client.ensure();
      const mcpServers = [acpMcpServer(tools.expose(opts.sessionId, opts.tools))];
      let id: string | undefined;
      let configOptions: unknown;
      if (opts.resumeId && client.loadSupported) {
        try {
          configOptions = (await client.loadSession(opts.resumeId, cwd, mcpServers)).configOptions;
          id = opts.resumeId;
        } catch (e) {
          ctx.log.warn("session/load failed, reseeding", { resumeId: opts.resumeId, error: String(e) });
        }
      }
      if (!id) {
        const r = await client.request("session/new", { cwd, mcpServers });
        id = String(r.sessionId);
        configOptions = r.configOptions;
      }
      const devin: DevinSession = new DevinSession({
        client,
        id,
        cwd,
        model: opts.model,
        ...(opts.effort === undefined ? {} : { effort: opts.effort }),
        ...(opts.fast === undefined ? {} : { fast: opts.fast }),
        configOptions,
        mcpServers,
        mode: permissionMode(ctx),
        reseeded: id !== opts.resumeId && opts.resumeId !== undefined,
        log: ctx.log,
        blobPath: (blobId) => ctx.store.blobs.path(blobId),
        onClose: () => {
          sessions.delete(devin);
          tools.revoke(opts.sessionId);
        },
      });
      await devin.configure();
      sessions.add(devin);
      client.guard(id, async (toolCall) => {
        // valet's own MCP tools are gated in ToolSurface.call; Devin asks about them too, so skip those here.
        const rule = (toolCall._meta as Record<string, unknown> | undefined)?.["cognition.ai/permissionRule"];
        if (typeof rule === "string" && rule.startsWith("mcp__valet__")) return undefined;
        const name = String(toolCall.title ?? toolCall.kind ?? "tool");
        const verdict = await opts.tools.authorize(name, toolCall.rawInput ?? {}, {
          callId: String(toolCall.toolCallId ?? ""),
        });
        return "denied" in verdict ? verdict.denied : undefined;
      });
      ctx.store.sessions.setProviderState(opts.sessionId, PROVIDER_KEY, { resumeId: id });
      return devin;
    },
  };
  return { provider, dispose: () => client.dispose() };
}
