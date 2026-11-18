/** A model the user adds by hand; `id` goes to the harness unchanged, `name` is the picker label. */
export interface CustomModel {
  id: string;
  name?: string;
}

export interface DevinConfig {
  command?: string[];
  permissionMode?: string;
  refusalFallback?: string[];
  models?: { id: string; name?: string; contextWindow?: number }[];
  /** Extra picker entries added to whatever `devin models` reports. Also in the settings panel. */
  customModels?: CustomModel[];
  denyKinds?: string[];
  hideFusion?: boolean;
  hideAdaptive?: boolean;
  /** Model for small side jobs such as session naming. Empty string turns them off. */
  utilityModel?: string;
}

export const DEFAULT_UTILITY_MODEL = "claude-haiku-5-5-low";

export const DEFAULT_MODELS = [
  "claude-opus-5-5-medium",
  "claude-sonnet-5-5-medium",
  "gpt-6-1-sol-medium",
  "swe-2-high",
  "glm-5-3-max",
  "claude-fable-5-2-medium",
];

export function spawnCommand(cfg: DevinConfig): string[] {
  return [
    ...(cfg.command ?? ["devin", "acp"]),
    ...(cfg.refusalFallback ?? []).flatMap((m) => ["--refusal-fallback", m]),
  ];
}
