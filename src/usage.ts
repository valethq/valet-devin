import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginContext, Display, SettingsTone } from "@valethq/sdk";
import type { DevinConfig } from "./config";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** Pace within this many points of an even burn-down counts as "on pace". */
const PACE_SLACK = 5;
/** A cached reading newer than this is reused; the quota endpoint is not meant to be hammered. */
const FRESH_MS = 60_000;
/** After a failed read, wait this long before trying again on its own. */
const RETRY_MS = 5 * 60_000;
/** "Refresh now" within this long of the last successful read is ignored. */
const MANUAL_GAP_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
/** How long the first view waits for a reading before showing "Reading usage". */
const FIRST_WAIT_MS = 3_000;

const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
const USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

const CLIENT_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
})();

export interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string;
}

export interface UsageWindow {
  label: string;
  /** Share of the window used, 0-100. */
  percent: number;
  /** Epoch ms. */
  resetsAt?: number;
  /** Window length, for the even-pace marker. Absent for balances that are not a time window. */
  windowMs?: number;
}

export interface UsageSnapshot {
  available: boolean;
  /** Shown when limits are unavailable (not logged in, login expired). */
  reason?: string;
  plan?: string;
  windows: UsageWindow[];
  /** Extra usage balance in USD, when the server sent one. */
  extraUsd?: number;
}

export interface UsageState {
  snapshot?: UsageSnapshot;
  at?: number;
  error?: string;
}

type Env = Record<string, string | undefined>;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function devinCredentialsPath(env: Env = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "share");
  return join(dataHome, "devin", "credentials.toml");
}

function tomlString(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"));
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value || undefined;
}

/** The key `devin auth login` writes. `windsurf_api_key` is the current name; `api_key` is the older one. */
export function parseDevinCredentials(source: string): DevinCredentials | undefined {
  const apiKey = tomlString(source, "windsurf_api_key") ?? tomlString(source, "api_key");
  if (!apiKey) return undefined;
  const apiServerUrl = (tomlString(source, "api_server_url") ?? DEFAULT_API_SERVER_URL).replace(/\/+$/, "");
  return { apiKey, apiServerUrl };
}

function isEnoent(error: unknown): boolean {
  return isObj(error) && error.code === "ENOENT";
}

export async function readDevinCredentials(env: Env = process.env): Promise<DevinCredentials | undefined> {
  try {
    return parseDevinCredentials(await readFile(devinCredentialsPath(env), "utf8"));
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

/** proto3 JSON encodes int64 as strings and omits zero values. */
function num(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function quotaWindow(
  label: string,
  remaining: unknown,
  resetAtUnix: unknown,
  windowMs: number,
): UsageWindow | undefined {
  const resetSeconds = num(resetAtUnix);
  const remainingPercent = num(remaining) ?? (resetSeconds ? 0 : undefined);
  if (remainingPercent === undefined) return undefined;
  const resetsAt = resetSeconds ? resetSeconds * 1000 : undefined;
  return {
    label,
    percent: clampPercent(100 - remainingPercent),
    ...(resetsAt !== undefined && { resetsAt }),
    windowMs,
  };
}

/**
 * A `GetUserStatusResponse` (Connect JSON), the payload behind Devin's `/usage` screen.
 * Hidden quota windows are skipped. A missing remaining percent with a reset time is a full window.
 */
export function parseDevinUserStatus(body: unknown): UsageSnapshot {
  const response = isObj(body) ? body : {};
  const userStatus = isObj(response.userStatus) ? response.userStatus : {};
  const planStatus = isObj(userStatus.planStatus) ? userStatus.planStatus : {};
  const planInfo = isObj(planStatus.planInfo)
    ? planStatus.planInfo
    : isObj(response.planInfo)
      ? response.planInfo
      : {};

  const windows: UsageWindow[] = [];
  if (planInfo.hideWeeklyQuota !== true) {
    const weekly = quotaWindow(
      "Weekly",
      planStatus.weeklyQuotaRemainingPercent,
      planStatus.weeklyQuotaResetAtUnix,
      WEEK_MS,
    );
    if (weekly) windows.push(weekly);
  }
  if (planInfo.hideDailyQuota !== true) {
    const daily = quotaWindow(
      "Daily",
      planStatus.dailyQuotaRemainingPercent,
      planStatus.dailyQuotaResetAtUnix,
      DAY_MS,
    );
    if (daily) windows.push(daily);
  }
  const acuLimit = num(planStatus.acuLimit);
  if (acuLimit !== undefined && acuLimit > 0) {
    const consumed = num(planStatus.acuConsumed) ?? 0;
    windows.push({
      label: "ACUs",
      percent: clampPercent((consumed / acuLimit) * 100),
    });
  }

  const overageMicros = num(planStatus.overageBalanceMicros);
  const plan = typeof planInfo.planName === "string" ? planInfo.planName.trim() : "";
  return {
    available: true,
    windows,
    ...(plan && { plan }),
    ...(overageMicros !== undefined && { extraUsd: overageMicros / 1_000_000 }),
  };
}

const capitalize = (s: string) => (s ? (s[0]?.toUpperCase() ?? "") + s.slice(1) : s);

function formatUsd(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/** Time left until `resetsAt` (epoch ms). */
export function untilReset(resetsAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (mins < 1) return "less than a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const rh = h % 24;
  return rh ? `${Math.floor(h / 24)}d ${rh}h` : `${Math.floor(h / 24)}d`;
}

const toneOf = (percent: number): SettingsTone =>
  percent >= 95 ? "critical" : percent >= 80 ? "warning" : "normal";

/** One meter per window: the bar shows what is left, the marker where an even burn-down would be by now. */
export function usageMeter(w: UsageWindow, now: number): Display {
  const used = Math.round(Math.min(100, Math.max(0, w.percent)));
  const left = 100 - used;
  const resetsAt = w.resetsAt;
  const remaining = resetsAt === undefined ? 0 : Math.max(0, resetsAt - now);
  const span = w.windowMs;
  const pace = remaining > 0 && span !== undefined && span > 0;
  const burned = pace ? Math.min(100, Math.max(0, (1 - remaining / span) * 100)) : 0;
  const status = !pace
    ? undefined
    : used > burned + PACE_SLACK
      ? "Over pace"
      : used < burned - PACE_SLACK
        ? "Under pace"
        : "On pace";
  return {
    type: "meter",
    label: w.label,
    value: left,
    display: `${left}% left`,
    ...(used > 0 &&
      remaining > 0 &&
      resetsAt !== undefined && { caption: `+${used}% in ${untilReset(resetsAt, now)}` }),
    ...(status !== undefined && { status }),
    ...(pace && { marker: 100 - burned }),
    tone: toneOf(used),
  };
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function usageBlocks(s: UsageState, now = Date.now()): Display[] {
  const out: Display[] = [];
  const snap = s.snapshot;
  if (!snap) {
    out.push({
      type: "note",
      text: s.error ? `Could not read usage: ${s.error}` : "Reading usage...",
      tone: s.error ? "warning" : "normal",
    });
  } else if (!snap.available) {
    out.push({ type: "note", text: snap.reason ?? "Plan limits are not available for this login." });
  } else {
    const body: Display[] = [
      ...(snap.plan ? [{ type: "badge" as const, text: capitalize(snap.plan) }] : []),
      ...snap.windows.map((w) => usageMeter(w, now)),
      ...(snap.extraUsd !== undefined
        ? [{ type: "stat" as const, label: "Extra usage balance", value: formatUsd(snap.extraUsd) }]
        : []),
    ];
    if (snap.windows.length === 0 && snap.extraUsd === undefined) {
      body.push({ type: "note", text: "No quota data available." });
    }
    out.push(...body);
    if (s.error) out.push({ type: "note", text: `Could not refresh usage: ${s.error}`, tone: "warning" });
  }
  if (snap || s.error) {
    out.push(...(s.at === undefined ? [] : [{ type: "note" as const, text: `Updated ${clock(s.at)}` }]), {
      type: "action",
      text: "Refresh now",
      action: "refresh",
    });
  }
  return out;
}

export interface UsageService {
  view(): Promise<Display[]>;
  refresh(force?: boolean): Promise<void>;
}

async function fetchDevinUserStatus(creds: DevinCredentials, fetchFn: FetchFn): Promise<UsageSnapshot> {
  const url = `${creds.apiServerUrl.replace(/\/+$/, "")}${USER_STATUS_PATH}`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", "connect-protocol-version": "1" },
      body: JSON.stringify({
        metadata: {
          apiKey: creds.apiKey,
          ideName: "devin-cli",
          ideVersion: CLIENT_VERSION,
          extensionName: "valet-devin",
          extensionVersion: CLIENT_VERSION,
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new Error("timed out reading usage");
    throw error;
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const detail = isObj(body) ? body : undefined;
    const code = typeof detail?.code === "string" ? detail.code : undefined;
    if (response.status === 401 || code === "unauthenticated") {
      return { available: false, windows: [], reason: "Devin CLI login expired; run `devin auth login`" };
    }
    throw new Error(`HTTP ${response.status}${code ? ` (${code})` : ""}`);
  }
  if (!isObj(body)) throw new Error("Unexpected GetUserStatus response");
  return parseDevinUserStatus(body);
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface UsageOpts {
  fetch?: FetchFn;
  readCredentials?: () => Promise<DevinCredentials | undefined>;
  now?: () => number;
}

/** Reads plan usage from Devin's GetUserStatus endpoint (no model turn) and caches it. */
export function createUsage(ctx: PluginContext<DevinConfig>, opts: UsageOpts = {}): UsageService {
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetch ?? fetch;
  const readCredentials = opts.readCredentials ?? (() => readDevinCredentials());
  const state: UsageState = {};
  let failedAt: number | undefined;
  let inflight: Promise<void> | undefined;

  async function read(): Promise<UsageSnapshot> {
    const creds = await readCredentials();
    if (!creds) {
      return { available: false, windows: [], reason: "Devin CLI is not logged in. Run `devin auth login`." };
    }
    return fetchDevinUserStatus(creds, fetchFn);
  }

  function refresh(force = false): Promise<void> {
    if (inflight) return inflight;
    const t = now();
    if (state.at !== undefined && t - state.at < (force ? MANUAL_GAP_MS : FRESH_MS)) return Promise.resolve();
    if (!force && failedAt !== undefined && t - failedAt < RETRY_MS) return Promise.resolve();
    inflight = read()
      .then((snapshot) => {
        state.snapshot = snapshot;
        state.at = now();
        delete state.error;
        failedAt = undefined;
      })
      .catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
        failedAt = now();
        ctx.log.warn("devin usage read failed", { error: state.error });
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    refresh,
    async view() {
      const pending = refresh();
      if (!state.snapshot && !state.error) {
        let wait: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([pending, new Promise<void>((r) => (wait = setTimeout(r, FIRST_WAIT_MS)))]);
        clearTimeout(wait);
      }
      return usageBlocks(state, now());
    },
  };
}
