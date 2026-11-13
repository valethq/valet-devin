import type { ModelInfo } from "@valethq/sdk";
import { type DevinConfig, DEFAULT_MODELS } from "./config";

const TTL_MS = 10 * 60_000;
const DEFAULT_WINDOW = 200_000;
const LINE = /^ {2}(\S+) {2,}(.+?) +\[(.*)\]\s*$/;
const CONTEXT = /(\d+(?:\.\d+)?)\s*([KM])\s+context/i;

export function toModelInfo(m: { id: string; name?: string; contextWindow?: number }): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? DEFAULT_WINDOW,
    maxOutputTokens: 32_000,
    input: ["text", "image"],
    reasoning: true,
  };
}

export function parseModels(output: string): { id: string; name: string; contextWindow: number }[] {
  const models: { id: string; name: string; contextWindow: number }[] = [];
  for (const line of output.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const ctx = CONTEXT.exec(m[3] ?? "");
    const contextWindow = ctx
      ? Math.round(Number(ctx[1]) * (ctx[2]?.toUpperCase() === "M" ? 1e6 : 1e3))
      : DEFAULT_WINDOW;
    models.push({ id: m[1] as string, name: m[2] as string, contextWindow });
  }
  return models;
}

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join("|")})$`);

export interface ResolvedModel {
  model: string;
  thoughtLevel?: string;
  speed?: "fast";
}

export function resolveModel(id: string, options: { models: string[] }): ResolvedModel | null {
  const { models } = options;
  if (models.includes(id)) return { model: id };
  let rest = id.replace(/-priority$/, "");
  const fast = /-(fast|lightning)$/.test(rest);
  rest = rest.replace(/-(fast|lightning)$/, "");
  const thoughtLevel = EFFORT_SUFFIX.exec(rest)?.[1];
  rest = rest.replace(EFFORT_SUFFIX, "");
  const withEffort = ["medium", "high"].map((e) => `${rest}-${e}`);
  const model =
    [rest, ...withEffort].find((m) => models.includes(m)) ??
    models.find((m) => m.startsWith(`${rest}-`) && EFFORTS.includes(m.slice(rest.length + 1)));
  if (!model) return null;
  return { model, ...(thoughtLevel && { thoughtLevel }), ...(fast && { speed: "fast" as const }) };
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

export function modelLister(
  cfg: DevinConfig,
  run: () => Promise<string> = runDevinModels,
  acpModels: () => Promise<string[] | undefined> = async () => undefined,
) {
  let cache: { at: number; models: ModelInfo[] } | undefined;
  return async (): Promise<ModelInfo[]> => {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
    try {
      let parsed = parseModels(await run());
      if (!parsed.length) throw new Error("no models parsed");
      const values = await acpModels().catch(() => undefined);
      if (values?.length) {
        const filtered = parsed.filter((m) => resolveModel(m.id, { models: values }));
        if (filtered.length) parsed = filtered;
      }
      cache = { at: Date.now(), models: parsed.map(toModelInfo) };
      return cache.models;
    } catch {
      return (cfg.models ?? DEFAULT_MODELS.map((id) => ({ id }))).map(toModelInfo);
    }
  };
}

async function runDevinModels(): Promise<string> {
  const proc = Bun.spawn(["devin", "models"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("devin models failed");
  return out;
}
