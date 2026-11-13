import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider, PluginContext, ScopeProvider } from "@valethq/sdk";
import plugin from "../src/index";
import type { DevinConfig } from "../src/config";

export const FAKE = join(import.meta.dir, "fixtures", "fake-acp.ts");
const noop = () => {};

export function fakeCtx(config: DevinConfig, blobs: Record<string, string> = {}) {
  const state: Record<string, unknown> = {};
  const logs: { level: string; msg: string; data?: unknown }[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  let provided: AgentProvider | undefined;
  const logger = (level: string) => (msg: string, data?: Record<string, unknown>) =>
    logs.push({ level, msg, data });
  const ctx = {
    config,
    log: { debug: logger("debug"), info: logger("info"), warn: logger("warn"), error: logger("error") },
    onDispose: (fn: () => void) => disposers.push(fn),
    scopes: {
      provide: (_s: string, impl: AgentProvider) => {
        provided = impl;
        return { dispose: noop };
      },
    },
    store: {
      sessions: {
        get: () => ({ projectId: "p1" }),
        setProviderState: (id: string, provider: string, s: unknown) => {
          state[`${id}:${provider}`] = s;
        },
      },
      projects: { get: () => ({ workspaceDir: "/tmp" }) },
      blobs: {
        path: (id: string) => {
          const p = blobs[id];
          if (p === undefined) throw new Error(`unknown blob "${id}"`);
          return p;
        },
      },
    },
  } as unknown as PluginContext<DevinConfig>;
  plugin.activate(ctx);
  return {
    provider: provided as AgentProvider,
    state,
    logs,
    dispose: async () => {
      for (const d of disposers.reverse()) await d();
    },
  };
}

export function fakeConfig(extra: DevinConfig = {}): { cfg: DevinConfig; logFile: string } {
  const logFile = join(mkdtempSync(join(tmpdir(), "fake-acp-")), "calls.log");
  return { cfg: { command: ["bun", FAKE, "--log", logFile], ...extra }, logFile };
}

export const calls = (logFile: string): { method: string; params: Record<string, unknown> }[] =>
  readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

export async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}

export const input = (text: string) => ({ content: [{ type: "text" as const, text }] });
export type { ScopeProvider };
