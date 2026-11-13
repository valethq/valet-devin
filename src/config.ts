export interface DevinConfig {
  command?: string[];
  permissionMode?: string;
  refusalFallback?: string[];
  models?: { id: string; name?: string; contextWindow?: number }[];
  denyKinds?: string[];
  hideFusion?: boolean;
  hideAdaptive?: boolean;
}

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
