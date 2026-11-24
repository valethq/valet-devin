import type { ModelInfo, ModelOptions } from "@valethq/sdk";
import { type DevinConfig, DEFAULT_MODELS, EFFORTS, type Effort, type ModelConfig } from "./config";

const TTL_MS = 10 * 60_000;
const DEFAULT_WINDOW = 200_000;
const LINE = /^ {2}(\S+)\s{2,}(.+?)(?:\s+\[(.*)\])?\s*$/;
const CONTEXT = /(\d+(?:\.\d+)?)\s*([KM])\s+context/i;
const SPEED_SUFFIX = /-(fast|priority|lightning)$/;
const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join("|")})$`);

export function toModelInfo(m: ModelConfig): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? DEFAULT_WINDOW,
    maxOutputTokens: m.maxOutputTokens ?? 32_000,
    input: ["text", "image"],
    reasoning: true,
    ...(m.efforts?.length ? { efforts: m.efforts } : {}),
    ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    ...(m.fast ? { fast: true } : {}),
  };
}

interface ParsedVariant {
  id: string;
  name: string;
  contextWindow?: number;
}

export function parseModels(output: string): ParsedVariant[] {
  const models: ParsedVariant[] = [];
  for (const line of output.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const ctx = CONTEXT.exec(m[3] ?? "");
    const contextWindow = ctx
      ? Math.round(Number(ctx[1]) * (ctx[2]?.toUpperCase() === "M" ? 1e6 : 1e3))
      : undefined;
    models.push({ id: m[1] as string, name: (m[2] as string).trim(), contextWindow });
  }
  const known = models
    .filter((m) => m.contextWindow !== undefined && !m.id.startsWith("fusion-"))
    .map((m) => m.contextWindow as number);
  const fallback = Math.max(0, ...known) || DEFAULT_WINDOW;
  return models.map((m) => ({ ...m, contextWindow: m.contextWindow ?? fallback }));
}

/** Strip a Devin variant id into base + effort + fast. Fusion ids stay whole. */
export function stripVariant(id: string): { base: string; effort?: Effort; fast: boolean } {
  if (id.startsWith("fusion-")) return { base: id, fast: /-(fast|priority|lightning)(?:-|$)/.test(id) };
  let rest = id;
  let fast = false;
  const speed = SPEED_SUFFIX.exec(rest);
  if (speed) {
    fast = true;
    rest = rest.slice(0, speed.index);
  }
  const effortMatch = EFFORT_SUFFIX.exec(rest);
  const effort = effortMatch?.[1] as Effort | undefined;
  if (effortMatch) rest = rest.slice(0, effortMatch.index);
  return { base: rest, ...(effort && { effort }), fast };
}

function cleanName(name: string): string {
  let n = name.trim();
  for (let i = 0; i < 5; i++) {
    const next = n
      .replace(
        /\s+(No Thinking|Thinking|Lightning|Fast|Priority|None|Minimal|Low|Medium|High|XHigh|Max)$/i,
        "",
      )
      .trim();
    if (next === n) break;
    n = next;
  }
  return n || name;
}

const effortRank = (e: Effort) => EFFORTS.indexOf(e);

/** Collapse `devin models` variants into one row per base id with efforts[] / fast. */
export function collapseModels(variants: ParsedVariant[]): ModelConfig[] {
  const order: string[] = [];
  const byId = new Map<
    string,
    { name: string; efforts: Set<Effort>; fast: boolean; contextWindow?: number; defaultEffort?: Effort }
  >();
  for (const v of variants) {
    const { base, effort, fast } = stripVariant(v.id);
    let row = byId.get(base);
    if (!row) {
      order.push(base);
      row = { name: cleanName(v.name), efforts: new Set(), fast: false, contextWindow: v.contextWindow };
      byId.set(base, row);
    }
    if (effort) {
      row.efforts.add(effort);
      if (!fast && row.defaultEffort === undefined) row.defaultEffort = effort;
    }
    if (fast) row.fast = true;
    if (v.contextWindow !== undefined) row.contextWindow = v.contextWindow;
    if (!fast) row.name = cleanName(v.name) || row.name;
  }
  return order.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    const efforts = [...row.efforts].sort((a, b) => effortRank(a) - effortRank(b));
    const defaultEffort =
      row.defaultEffort && efforts.includes(row.defaultEffort)
        ? row.defaultEffort
        : efforts.includes("medium")
          ? "medium"
          : efforts[0];
    return [
      {
        id,
        name: row.name,
        contextWindow: row.contextWindow,
        ...(efforts.length ? { efforts, ...(defaultEffort && { defaultEffort }) } : {}),
        ...(row.fast ? { fast: true } : {}),
      },
    ];
  });
}

/** An effort Devin takes, or undefined for anything else. */
export const asEffort = (v: string | undefined): Effort | undefined =>
  v !== undefined && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : undefined;

export interface ResolvedAcp {
  model: string;
  thoughtLevel?: string;
  speed?: "fast" | "standard";
}

/** Map a base model + ModelOptions onto ACP's model / thought_level / speed values. */
export function toAcp(model: string, options: ModelOptions, acpModels: string[]): ResolvedAcp | null {
  const effort = asEffort(options.effort);
  const pick = acpModels.includes(model)
    ? model
    : (["medium", "high"].map((e) => `${model}-${e}`).find((m) => acpModels.includes(m)) ??
      acpModels.find((m) => {
        if (!m.startsWith(`${model}-`)) return false;
        const rest = m.slice(model.length + 1);
        return (EFFORTS as readonly string[]).includes(rest);
      }));
  if (!pick) return null;
  return {
    model: pick,
    ...(effort && { thoughtLevel: effort }),
    ...(options.fast === true
      ? { speed: "fast" as const }
      : options.fast === false
        ? { speed: "standard" as const }
        : {}),
  };
}

type Option = { value?: unknown; options?: Option[] };

export function optionValues(configOptions: unknown, configId: string): string[] {
  const opt = (
    Array.isArray(configOptions) ? (configOptions as { id?: string; options?: Option[] }[]) : []
  ).find((o) => o.id === configId);
  const flat = (list: Option[] = []): string[] =>
    list.flatMap((o) => (o.options ? flat(o.options) : typeof o.value === "string" ? [o.value] : []));
  return flat(opt?.options);
}

export interface HiddenModels {
  fusion: boolean;
  adaptive: boolean;
}

export function isHidden(id: string, hidden: HiddenModels): boolean {
  return (hidden.fusion && id.startsWith("fusion-")) || (hidden.adaptive && id === "adaptive");
}

/** Hidden filter is applied per call, so a settings change shows up without waiting out the cache. */
export function modelLister(
  cfg: () => DevinConfig | undefined,
  run: () => Promise<string> = runDevinModels,
  acpModels: () => Promise<string[] | undefined> = async () => undefined,
  hidden: () => HiddenModels = () => ({ fusion: true, adaptive: true }),
) {
  let cache: { at: number; models: ModelConfig[] } | undefined;
  return async (): Promise<ModelInfo[]> => {
    const keep = (models: ModelConfig[]) => models.filter((m) => !isHidden(m.id, hidden())).map(toModelInfo);
    const configured = cfg()?.models;
    if (configured) return keep(configured);
    if (cache && Date.now() - cache.at < TTL_MS) return keep(cache.models);
    try {
      let collapsed = collapseModels(parseModels(await run()));
      if (!collapsed.length) throw new Error("no models parsed");
      const values = await acpModels().catch(() => undefined);
      if (values?.length) {
        const filtered = collapsed.filter((m) => toAcp(m.id, {}, values));
        if (filtered.length) collapsed = filtered;
      }
      cache = { at: Date.now(), models: collapsed };
      return keep(cache.models);
    } catch {
      return keep(DEFAULT_MODELS);
    }
  };
}

async function runDevinModels(): Promise<string> {
  const proc = Bun.spawn(["devin", "models"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("devin models failed");
  return out;
}
