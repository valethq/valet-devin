import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext, SettingsPanel } from "@valethq/sdk";
import type { DevinConfig } from "../src/config";
import { hideAdaptive, hideFusion, permissionMode, registerSettings, utilityModel } from "../src/settings";
import { createUsage } from "../src/usage";
import { fakeCtx } from "./helpers";

function ctxWith(config: DevinConfig) {
  const { ctx } = fakeCtx({ command: ["true"], ...config });
  return ctx as unknown as PluginContext<DevinConfig>;
}

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"));
const props = manifest.configSchema.properties as Record<string, { default?: unknown }>;

describe("settings are config", () => {
  test("accessors fall back to the same defaults the manifest declares", () => {
    const ctx = ctxWith({});
    expect(permissionMode(ctx)).toBe(props.permissionMode?.default as "accept-edits");
    expect(hideFusion(ctx)).toBe(props.hideFusion?.default as boolean);
    expect(hideAdaptive(ctx)).toBe(props.hideAdaptive?.default as boolean);
    expect(utilityModel(ctx)).toBe(props.utilityModel?.default as string);
  });

  test("config values win; an empty utility model turns side jobs off", () => {
    const ctx = ctxWith({
      permissionMode: "plan",
      hideFusion: false,
      hideAdaptive: false,
      utilityModel: " ",
    });
    expect(permissionMode(ctx)).toBe("plan");
    expect(hideFusion(ctx)).toBe(false);
    expect(hideAdaptive(ctx)).toBe(false);
    expect(utilityModel(ctx)).toBeUndefined();
  });

  test("the manifest no longer carries per-provider custom models", () => {
    expect(props.customModels).toBeUndefined();
  });

  test("the manifest provides the settings scope for the usage panel", () => {
    expect(manifest.provides).toEqual(["inference@1", "settings@1"]);
  });

  test("setConfig updates what accessors read", () => {
    const { ctx, setConfig } = fakeCtx({ command: ["true"], permissionMode: "smart" });
    expect(permissionMode(ctx)).toBe("smart");
    setConfig({ permissionMode: "plan", hideFusion: false, utilityModel: "swe-2" });
    expect(permissionMode(ctx)).toBe("plan");
    expect(hideFusion(ctx)).toBe(false);
    expect(utilityModel(ctx)).toBe("swe-2");
  });
});

describe("usage on the settings page", () => {
  test("a view-only panel: plan usage, refreshed on a timer, with a refresh action", async () => {
    const { ctx } = fakeCtx({ command: ["true"] });
    const usage = createUsage(ctx, {
      now: () => Date.parse("2026-11-19T12:00:00Z"),
      readCredentials: async () => ({ apiKey: "sk-1", apiServerUrl: "https://server.example.com" }),
      fetch: async () =>
        new Response(
          JSON.stringify({
            userStatus: {
              planStatus: {
                planInfo: { planName: "Max", hideDailyQuota: true },
                weeklyQuotaRemainingPercent: 99,
                weeklyQuotaResetAtUnix: "1795334400",
                overageBalanceMicros: "9803175",
              },
            },
          }),
          { status: 200 },
        ),
    });
    let panel: SettingsPanel | undefined;
    registerSettings(
      {
        ...ctx,
        scopes: {
          define() {},
          provide(_s: string, impl: SettingsPanel) {
            panel = impl;
            return { dispose() {} };
          },
        },
      } as unknown as PluginContext<DevinConfig>,
      usage,
    );
    expect(panel?.schema).toBeUndefined();
    expect(panel?.title).toBe("Plan usage");
    expect(panel?.refreshMs).toBe(15_000);
    const blocks = (await panel?.view?.()) ?? [];
    const text = JSON.stringify(blocks);
    expect(text).toContain('"text":"Max"');
    expect(text).toContain('"label":"Weekly"');
    expect(text).toContain("1% used");
    expect(text).toContain("Extra usage balance");
    expect(text).not.toContain('"label":"Daily"');
    await panel?.actions?.refresh?.({});
  });
});
