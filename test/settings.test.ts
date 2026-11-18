import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext } from "@valethq/sdk";
import type { DevinConfig } from "../src/config";
import { hideAdaptive, hideFusion, permissionMode, utilityModel } from "../src/settings";
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

  test("the manifest no longer carries per-provider custom models or a settings panel", () => {
    expect(props.customModels).toBeUndefined();
    expect(manifest.provides).toEqual(["inference@1"]);
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
