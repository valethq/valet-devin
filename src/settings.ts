import type { PluginContext } from "@valethq/sdk";
import { type CustomModel, DEFAULT_UTILITY_MODEL, type DevinConfig } from "./config";

export interface SettingsPanel {
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  get(): Record<string, unknown> | Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): void | Promise<void>;
}

declare module "@valethq/sdk" {
  interface ValetScopes {
    settings: SettingsPanel;
  }
}

const MODES = ["normal", "accept-edits", "smart", "plan", "bypass"] as const;
type Mode = (typeof MODES)[number];

/** Panel value wins over config.json so the UI can flip it without a restart. */
export function permissionMode(ctx: PluginContext<DevinConfig>): Mode {
  const v = ctx.storage.kv.get<string>("permissionMode") ?? ctx.config?.permissionMode;
  return (MODES as readonly string[]).includes(v ?? "") ? (v as Mode) : "accept-edits";
}

type Flag = "hideFusion" | "hideAdaptive";

/** Hidden by default. Panel value wins over config.json, as with permissionMode. */
function flag(ctx: PluginContext<DevinConfig>, key: Flag): boolean {
  const v = ctx.storage.kv.get<boolean>(key) ?? ctx.config?.[key];
  return typeof v === "boolean" ? v : true;
}

export const hideFusion = (ctx: PluginContext<DevinConfig>): boolean => flag(ctx, "hideFusion");
export const hideAdaptive = (ctx: PluginContext<DevinConfig>): boolean => flag(ctx, "hideAdaptive");

/** The Utility model. Panel value wins over config.json; an empty string turns it off. */
export function utilityModel(ctx: PluginContext<DevinConfig>): string | undefined {
  const v = ctx.storage.kv.get<string>("utilityModel") ?? ctx.config?.utilityModel ?? DEFAULT_UTILITY_MODEL;
  return v.trim() === "" ? undefined : v.trim();
}

/** Panel value wins over config.json. Entries without an id are dropped. */
export function customModels(ctx: PluginContext<DevinConfig>): CustomModel[] {
  const v = ctx.storage.kv.get<unknown>("customModels") ?? ctx.config?.customModels;
  return Array.isArray(v)
    ? v
        .filter(isCustomModel)
        .map(({ id, name }) => ({ id: id.trim(), ...(name?.trim() && { name: name.trim() }) }))
    : [];
}

const isCustomModel = (m: unknown): m is CustomModel =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as CustomModel).id === "string" &&
  (m as CustomModel).id.trim() !== "";

export function registerSettings(ctx: PluginContext<DevinConfig>): void {
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.scopes.provide(
    "settings",
    {
      title: "Devin CLI",
      description: "Overrides plugins.valet-devin.config; applies to newly opened sessions.",
      schema: {
        type: "object",
        properties: {
          permissionMode: {
            type: "string",
            title: "Permission mode",
            description: "Sent as modeId to session/set_mode when a session opens.",
            enum: MODES,
            enumNames: ["Normal", "Accept edits", "Smart", "Plan", "Bypass permissions"],
          },
          hideFusion: {
            type: "boolean",
            title: "Hide Fusion models",
            description: "Hides the fusion-* model variants from the model list.",
          },
          hideAdaptive: {
            type: "boolean",
            title: "Hide Adaptive",
            description: "Hides the adaptive model from the model list.",
          },
          customModels: {
            type: "array",
            title: "Custom models",
            description: "Extra models for the picker. The model name is sent to devin as is.",
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", title: "Model name" },
                name: { type: "string", title: "Friendly name" },
              },
            },
          },
          utilityModel: {
            type: "string",
            title: "Utility model",
            description: "Model for small side jobs such as naming sessions. Empty turns them off.",
          },
        },
      },
      get: () => ({
        permissionMode: permissionMode(ctx),
        utilityModel: utilityModel(ctx) ?? "",
        customModels: customModels(ctx),
        hideFusion: hideFusion(ctx),
        hideAdaptive: hideAdaptive(ctx),
      }),
      set: (v) => {
        const mode = v.permissionMode;
        if (mode !== undefined && (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)))
          throw new Error(`permissionMode must be one of: ${MODES.join(", ")}`);
        for (const key of ["hideFusion", "hideAdaptive"] as const) {
          if (v[key] !== undefined && typeof v[key] !== "boolean")
            throw new Error(`${key} must be a boolean`);
        }
        if (v.utilityModel !== undefined && typeof v.utilityModel !== "string")
          throw new Error("utilityModel must be a string");
        if (
          v.customModels !== undefined &&
          !(Array.isArray(v.customModels) && v.customModels.every(isCustomModel))
        )
          throw new Error("customModels entries need a model name");
        if (v.customModels !== undefined) ctx.storage.kv.set("customModels", v.customModels);
        if (mode !== undefined) ctx.storage.kv.set("permissionMode", mode);
        if (typeof v.utilityModel === "string") ctx.storage.kv.set("utilityModel", v.utilityModel);
        for (const key of ["hideFusion", "hideAdaptive"] as const) {
          const value = v[key];
          if (typeof value === "boolean") ctx.storage.kv.set(key, value);
        }
      },
    },
    { key: "valet-devin" },
  );
}
