export type PermissionMode = "normal" | "accept-edits" | "smart" | "plan" | "bypass";
export const MODES: readonly PermissionMode[] = ["normal", "accept-edits", "smart", "plan", "bypass"];

/** Every effort Devin's model list uses as a suffix, lowest first. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Effort levels the model takes. Unset = none to pick. */
  efforts?: Effort[];
  defaultEffort?: Effort;
  /** Devin's fast / lightning / priority serving tier is available. */
  fast?: boolean;
}

export interface DevinConfig {
  command?: string[];
  permissionMode?: PermissionMode;
  refusalFallback?: string[];
  /** Replaces the live `devin models` list when set. */
  models?: ModelConfig[];
  denyKinds?: string[];
  hideFusion?: boolean;
  hideAdaptive?: boolean;
  /** Model for small side jobs such as session naming. Empty string turns them off. */
  utilityModel?: string;
}

export const DEFAULT_UTILITY_MODEL = "claude-haiku-5-5";

const CLAUDE5_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Fallback when `devin models` is unavailable (OpenClaw's list, base ids). */
export const DEFAULT_MODELS: ModelConfig[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    efforts: CLAUDE5_EFFORTS,
    defaultEffort: "medium",
    fast: true,
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    efforts: CLAUDE5_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "gpt-6-1-sol",
    name: "GPT-6.1 Sol",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    fast: true,
  },
  { id: "swe-2", name: "SWE-2", efforts: ["medium", "high", "max"], defaultEffort: "high", fast: true },
  { id: "glm-5-3", name: "GLM-5.3", efforts: ["low", "high", "max"], defaultEffort: "max" },
  {
    id: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    efforts: CLAUDE5_EFFORTS,
    defaultEffort: "medium",
    fast: true,
  },
];

export function spawnCommand(cfg: DevinConfig): string[] {
  return [
    ...(cfg.command ?? ["devin", "acp"]),
    ...(cfg.refusalFallback ?? []).flatMap((m) => ["--refusal-fallback", m]),
  ];
}
