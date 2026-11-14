import { expect, test } from "bun:test";
import type { PluginContext } from "@valethq/sdk";
import { fakeConfig } from "./helpers";
import {
  hideAdaptive,
  hideFusion,
  permissionMode,
  registerSettings,
  utilityModel,
  type SettingsPanel,
} from "../src/settings";
import type { DevinConfig } from "../src/config";

function kvCtx(config: DevinConfig) {
  const kv = new Map<string, unknown>();
  const panels: { key?: string; impl: SettingsPanel }[] = [];
  const ctx = {
    config,
    storage: {
      kv: {
        get: <T>(k: string) => kv.get(k) as T | undefined,
        set: (k: string, v: unknown) => void kv.set(k, v),
        delete: (k: string) => void kv.delete(k),
        list: () => [...kv.keys()],
      },
    },
    scopes: {
      define: () => {},
      provide: (_s: string, impl: SettingsPanel, opts?: { key?: string }) => {
        panels.push({ key: opts?.key, impl });
        return { dispose() {} };
      },
    },
  } as unknown as PluginContext<DevinConfig>;
  return { ctx, kv, panels };
}

test("permissionMode prefers kv, then config, then accept-edits", () => {
  const { cfg } = fakeConfig({ permissionMode: "smart" });
  const { ctx, kv } = kvCtx(cfg);
  expect(permissionMode(ctx)).toBe("smart");
  kv.set("permissionMode", "plan");
  expect(permissionMode(ctx)).toBe("plan");
  kv.set("permissionMode", "bogus");
  expect(permissionMode(ctx)).toBe("accept-edits");
});

test("settings panel reports and validates permissionMode", async () => {
  const { cfg } = fakeConfig({ permissionMode: "smart" });
  const { ctx, panels } = kvCtx(cfg);
  registerSettings(ctx);
  const panel = panels[0];
  expect(panel?.key).toBe("valet-devin");
  expect(await panel?.impl.get()).toMatchObject({ permissionMode: "smart" });
  await panel?.impl.set({ permissionMode: "plan" });
  expect(await panel?.impl.get()).toMatchObject({ permissionMode: "plan" });
  expect(() => panel?.impl.set({ permissionMode: "yolo" })).toThrow("permissionMode");
});

test("hideFusion and hideAdaptive default on, follow config, and can be flipped in the panel", async () => {
  const { ctx, panels } = kvCtx({});
  expect(hideFusion(ctx)).toBe(true);
  expect(hideAdaptive(ctx)).toBe(true);
  const off = kvCtx({ hideFusion: false, hideAdaptive: false });
  expect(hideFusion(off.ctx)).toBe(false);
  expect(hideAdaptive(off.ctx)).toBe(false);

  registerSettings(ctx);
  const panel = panels[0];
  expect(await panel?.impl.get()).toEqual({
    permissionMode: "accept-edits",
    utilityModel: "claude-haiku-5-5-low",
    hideFusion: true,
    hideAdaptive: true,
  });
  await panel?.impl.set({ hideFusion: false });
  expect(hideFusion(ctx)).toBe(false);
  expect(hideAdaptive(ctx)).toBe(true);
  expect(() => panel?.impl.set({ hideAdaptive: "yes" })).toThrow("hideAdaptive must be a boolean");
});

test("utilityModel prefers the panel, then config; empty turns it off", async () => {
  const { ctx, panels } = kvCtx({ utilityModel: "swe-2-flash-medium" });
  expect(utilityModel(ctx)).toBe("swe-2-flash-medium");
  registerSettings(ctx);
  await panels[0]?.impl.set({ utilityModel: "claude-haiku-5-5-low" });
  expect(utilityModel(ctx)).toBe("claude-haiku-5-5-low");
  await panels[0]?.impl.set({ utilityModel: "" });
  expect(utilityModel(ctx)).toBeUndefined();
  expect(() => panels[0]?.impl.set({ utilityModel: 3 })).toThrow("utilityModel must be a string");
});
