import type { PluginContext } from "@valethq/sdk";
import { DEFAULT_UTILITY_MODEL, type DevinConfig, MODES, type PermissionMode } from "./config";

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
