import type { PluginContext } from "@valethq/sdk";
import { DEFAULT_UTILITY_MODEL, type DevinConfig, MODES, type PermissionMode } from "./config";
import { createUsage, type UsageService } from "./usage";

type Ctx = PluginContext<DevinConfig>;

const oneOf = <T extends string>(all: readonly T[], v: unknown, fallback: T): T =>
  (all as readonly unknown[]).includes(v) ? (v as T) : fallback;

// Settings are config (12.1): core fills in the manifest's defaults, so these fallbacks only matter without it.

export function permissionMode(ctx: Ctx): PermissionMode {
  return oneOf(MODES, ctx.config?.permissionMode, "accept-edits");
}

/** Hidden by default. */
export const hideFusion = (ctx: Ctx): boolean => ctx.config?.hideFusion ?? true;

/** Hidden by default. */
export const hideAdaptive = (ctx: Ctx): boolean => ctx.config?.hideAdaptive ?? true;

/** The Utility model; an empty string turns it off. */
export function utilityModel(ctx: Ctx): string | undefined {
  const v = (ctx.config?.utilityModel ?? DEFAULT_UTILITY_MODEL).trim();
  return v === "" ? undefined : v;
}

/** The plugin's settings page carries live plan usage above the config form. */
export function registerSettings(ctx: Ctx, usage: UsageService = createUsage(ctx)): void {
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.scopes.provide(
    "settings",
    {
      title: "Plan usage",
      view: () => usage.view(),
      refreshMs: 15_000,
      actions: { refresh: () => usage.refresh(true) },
    },
    { key: "valet-devin" },
  );
}
