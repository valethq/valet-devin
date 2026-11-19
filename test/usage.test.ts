import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext } from "@valethq/sdk";
import type { DevinConfig } from "../src/config";
import {
  createUsage,
  devinCredentialsPath,
  parseDevinCredentials,
  parseDevinUserStatus,
  readDevinCredentials,
  usageBlocks,
  usageMeter,
  type UsageWindow,
} from "../src/usage";
import { fakeCtx } from "./helpers";

const WEEK_MS = 7 * 86_400_000;
const RESET = 1_795_334_400_000;
/** Halfway through the week that ends at RESET. */
const NOW = RESET - WEEK_MS / 2;

/** The shape GetUserStatus returns for a quota plan with the daily window hidden. */
const maxPlan = {
  userStatus: {
    planStatus: {
      planInfo: { planName: "Max", billingStrategy: "BILLING_STRATEGY_QUOTA", hideDailyQuota: true },
      dailyQuotaRemainingPercent: 100,
      weeklyQuotaRemainingPercent: 99,
      overageBalanceMicros: "9803175",
      dailyQuotaResetAtUnix: "1795161600",
      weeklyQuotaResetAtUnix: "1795334400",
    },
  },
};

describe("credentials", () => {
  test("path follows XDG_DATA_HOME, then HOME", () => {
    expect(devinCredentialsPath({ XDG_DATA_HOME: "/x", HOME: "/h" })).toBe("/x/devin/credentials.toml");
    expect(devinCredentialsPath({ HOME: "/h" })).toBe("/h/.local/share/devin/credentials.toml");
  });

  test("parses credentials.toml", () => {
    expect(
      parseDevinCredentials('windsurf_api_key = "sk-1"\napi_server_url = "https://server.example.com/"\n'),
    ).toEqual({ apiKey: "sk-1", apiServerUrl: "https://server.example.com" });
    expect(parseDevinCredentials("api_key = 'sk-2'\n")).toEqual({
      apiKey: "sk-2",
      apiServerUrl: "https://server.codeium.com",
    });
    expect(parseDevinCredentials('api_server_url = "https://x"\n')).toBeUndefined();
  });

  test("reads the file and treats a missing one as logged out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-cred-"));
    mkdirSync(join(dir, "devin"));
    writeFileSync(
      join(dir, "devin", "credentials.toml"),
      'windsurf_api_key = "sk-1"\napi_server_url = "https://server.example.com/"\n',
    );
    expect(await readDevinCredentials({ XDG_DATA_HOME: dir, HOME: "/unused" })).toEqual({
      apiKey: "sk-1",
      apiServerUrl: "https://server.example.com",
    });
    expect(
      await readDevinCredentials({ XDG_DATA_HOME: join(dir, "missing"), HOME: "/unused" }),
    ).toBeUndefined();
  });
});

describe("parseDevinUserStatus", () => {
  test("maps weekly used, plan and extra usage, and skips a hidden daily cap", () => {
    expect(parseDevinUserStatus(maxPlan)).toEqual({
      available: true,
      plan: "Max",
      windows: [{ label: "Weekly", percent: 1, resetsAt: RESET, windowMs: WEEK_MS }],
      extraUsd: 9.803175,
    });
  });

  test("shows a daily cap, a full omitted window, and ACUs", () => {
    const snapshot = parseDevinUserStatus({
      planInfo: { planName: "pro" },
      userStatus: {
        planStatus: {
          dailyQuotaRemainingPercent: 75,
          dailyQuotaResetAtUnix: "1795161600",
          weeklyQuotaResetAtUnix: "1795334400",
          acuConsumed: 30,
          acuLimit: "120",
        },
      },
    });
    expect(snapshot.plan).toBe("pro");
    expect(snapshot.extraUsd).toBeUndefined();
    expect(snapshot.windows).toEqual([
      { label: "Weekly", percent: 100, resetsAt: RESET, windowMs: WEEK_MS },
      { label: "Daily", percent: 25, resetsAt: 1_795_161_600_000, windowMs: 86_400_000 },
      { label: "ACUs", percent: 25, display: "30 of 120" },
    ]);
  });

  test("garbage is an empty reading, not a throw", () => {
    expect(parseDevinUserStatus(undefined)).toEqual({ available: true, windows: [] });
    expect(parseDevinUserStatus("nope")).toEqual({ available: true, windows: [] });
  });
});

describe("usageMeter", () => {
  const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({
    label: "Weekly",
    percent: 1,
    resetsAt: RESET,
    windowMs: WEEK_MS,
    ...over,
  });

  test("shows percent used, time until reset, and an even-pace marker", () => {
    expect(usageMeter(window(), NOW)).toEqual({
      type: "meter",
      label: "Weekly",
      value: 1,
      display: "1% used",
      caption: "resets in 3d 12h",
      status: "Under pace",
      marker: 50,
      tone: "normal",
    });
  });

  test("a window past the even pace warns as it fills", () => {
    expect(usageMeter(window({ percent: 80 }), NOW)).toMatchObject({
      display: "80% used",
      status: "Over pace",
      tone: "warning",
    });
    const full = usageMeter(window({ percent: 96, resetsAt: undefined, windowMs: undefined }), NOW);
    if (full.type !== "meter") throw new Error("expected a meter");
    expect(full.tone).toBe("critical");
  });
});

describe("usageBlocks", () => {
  test("plan badge, meters, extra balance, and a refresh action", () => {
    const blocks = usageBlocks({ snapshot: parseDevinUserStatus(maxPlan), at: NOW }, NOW);
    const [usage, footer] = blocks;
    expect(usage).toMatchObject({ type: "group", title: "Plan usage" });
    if (usage?.type !== "group" || footer?.type !== "group") throw new Error("expected two groups");
    expect(usage.blocks.map((b) => b.type)).toEqual(["badge", "meter", "stat"]);
    expect(usage.blocks[0]).toEqual({ type: "badge", text: "Max" });
    expect(usage.blocks[2]).toEqual({ type: "stat", label: "Extra usage balance", value: "$9.80" });
    expect(footer.blocks.map((b) => b.type)).toEqual(["text", "button"]);
    expect(footer.blocks[1]).toMatchObject({ type: "button", label: "Refresh now", action: "refresh" });
  });

  test("missing and failed readings", () => {
    expect(usageBlocks({}, NOW)).toEqual([{ type: "text", text: "Reading usage...", tone: "normal" }]);
    expect(usageBlocks({ error: "boom" }, NOW)[0]).toEqual({
      type: "text",
      text: "Could not read usage: boom",
      tone: "warning",
    });
    const signedOut = usageBlocks(
      {
        snapshot: {
          available: false,
          windows: [],
          reason: "Devin CLI is not logged in. Run `devin auth login`.",
        },
      },
      NOW,
    );
    expect(signedOut[0]).toEqual({
      type: "text",
      text: "Devin CLI is not logged in. Run `devin auth login`.",
    });
  });
});

describe("createUsage", () => {
  const ctx = () => fakeCtx({ command: ["true"] }).ctx as unknown as PluginContext<DevinConfig>;

  test("posts Connect JSON with the API key and caches the reading", async () => {
    let calls = 0;
    let t = NOW;
    const usage = createUsage(ctx(), {
      now: () => t,
      readCredentials: async () => ({ apiKey: "sk-1", apiServerUrl: "https://server.example.com/" }),
      fetch: async (url, init) => {
        calls += 1;
        expect(String(url)).toBe(
          "https://server.example.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
        );
        const request = init?.body ? JSON.parse(String(init.body)) : {};
        expect(request.metadata.apiKey).toBe("sk-1");
        expect(request.metadata.ideName).toBe("devin-cli");
        expect(request.metadata.extensionName).toBe("valet-devin");
        expect(request.metadata.ideVersion).toBe(request.metadata.extensionVersion);
        const headers = init?.headers;
        if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) {
          throw new Error("expected a headers object");
        }
        expect(headers["connect-protocol-version"]).toBe("1");
        return new Response(JSON.stringify(maxPlan), { status: 200 });
      },
    });
    const blocks = await usage.view();
    expect(JSON.stringify(blocks)).toContain("1% used");
    expect(calls).toBe(1);
    t += 5_000;
    await usage.refresh(true);
    expect(calls).toBe(1);
    t += 60_000;
    await usage.refresh();
    expect(calls).toBe(2);
  });

  test("a missing login is a reason, an expired login too, and HTTP errors back off", async () => {
    const signedOut = createUsage(ctx(), {
      now: () => NOW,
      readCredentials: async () => undefined,
      fetch: async () => {
        throw new Error("should not be called");
      },
    });
    expect(JSON.stringify(await signedOut.view())).toContain("not logged in");

    const expired = createUsage(ctx(), {
      now: () => NOW,
      readCredentials: async () => ({ apiKey: "bad", apiServerUrl: "https://server.example.com" }),
      fetch: async () => new Response(JSON.stringify({ code: "unauthenticated" }), { status: 401 }),
    });
    expect(JSON.stringify(await expired.view())).toContain("devin auth login");

    let calls = 0;
    let t = NOW;
    const { ctx: logCtx, logs } = fakeCtx({ command: ["true"] });
    const failed = createUsage(logCtx, {
      now: () => t,
      readCredentials: async () => ({ apiKey: "sk", apiServerUrl: "https://server.example.com" }),
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ code: "unavailable" }), { status: 503 });
      },
    });
    const blocks = await failed.view();
    expect(blocks[0]).toEqual({
      type: "text",
      text: "Could not read usage: HTTP 503 (unavailable)",
      tone: "warning",
    });
    expect(logs.some((l) => l.level === "warn" && l.msg === "devin usage read failed")).toBe(true);
    t += 60_000;
    await failed.refresh();
    expect(calls).toBe(1);
    t += 5 * 60_000;
    await failed.refresh();
    expect(calls).toBe(2);
  });
});
