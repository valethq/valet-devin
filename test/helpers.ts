import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider, PluginContext, ScopeProvider, ToolSurface } from "@valethq/sdk";

export const noTools: ToolSurface = {
  list: () => [],
  call: async () => ({ content: [] }),
  authorize: async (_name, input) => ({ input }),
};
import plugin from "../src/index";
import type { DevinConfig } from "../src/config";

export const FAKE = join(import.meta.dir, "fixtures", "fake-acp.ts");
const noop = () => {};

export function fakeCtx(config: DevinConfig, blobs: Record<string, string> = {}) {
  const state: Record<string, unknown> = {};
  const kv = new Map<string, unknown>();
  const logs: { level: string; msg: string; data?: unknown }[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  let provided: AgentProvider | undefined;
  const listeners: ((next: DevinConfig, prev: DevinConfig) => void | Promise<void>)[] = [];
  let current = config;
  const logger = (level: string) => (msg: string, data?: Record<string, unknown>) =>
    logs.push({ level, msg, data });
  const ctx = {
    plugin: { version: "0.1.0" },
    http: {
      route: () => ({ dispose() {} }),
      url: (path: string) => `http://127.0.0.1:7437/plugins/valet-devin${path}`,
    },
    get config() {
      return current;
    },
    log: { debug: logger("debug"), info: logger("info"), warn: logger("warn"), error: logger("error") },
    onDispose: (fn: () => void) => disposers.push(fn),
    onConfigChange: (fn: (typeof listeners)[number]) => listeners.push(fn),
    scopes: {
      define: noop,
      provide: (s: string, impl: AgentProvider) => {
        if (s === "inference") provided = impl;
        return { dispose: noop };
      },
    },
    storage: {
      kv: {
        get: <T>(k: string) => kv.get(k) as T | undefined,
        set: (k: string, v: unknown) => void kv.set(k, v),
        delete: (k: string) => void kv.delete(k),
        list: () => [...kv.keys()],
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
  /** What core does on a settings save: the new block replaces ctx.config. */
  const setConfig = (patch: Partial<DevinConfig>) => {
    current = { ...current, ...patch };
  };
  return {
    provider: provided as AgentProvider,
    state,
    logs,
    kv,
    ctx,
    setConfig,
    reconfigure: async (next: DevinConfig) => {
      const prev = current;
      current = next;
      for (const fn of listeners) await fn(next, prev);
    },
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
