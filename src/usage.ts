import { readFile as nodeReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeConfigDir } from "./accounts/store.js";

export interface Window {
  usedPercent: number;
  resetsAt: number | null;
}
export type UsageResult =
  | { ok: true; fiveHour: Window | null; weekly: Window | null }
  | { ok: false; reason: "expired" | "unavailable" | "invalid" }
  /** `status` is absent when the request never got a response (network error or timeout). */
  | { ok: false; reason: "http"; status?: number }
  | { ok: false; reason: "rate-limited"; retryAfterMs: number | null };
export interface UsageDependencies {
  fetch?: typeof globalThis.fetch;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  now?: () => number;
}
export const usageDefaults: Required<UsageDependencies> = {
  fetch: (...args) => globalThis.fetch(...args),
  readFile: (path: string, encoding: "utf8") => nodeReadFile(path, encoding),
  now: () => Date.now(),
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWindow(value: unknown): Window | null | undefined {
  if (value === null) return null;
  if (!record(value) || typeof value.utilization !== "number" ||
      !Number.isFinite(value.utilization) || value.utilization < 0 || value.utilization > 100) return undefined;
  const reset = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN;
  return { usedPercent: value.utilization, resetsAt: Number.isFinite(reset) ? reset : null };
}

const HEADER_PREFIX = "anthropic-ratelimit-unified";

/**
 * Reads the unified rate-limit headers that pi-claude-bridge rebuilds from Claude Code's
 * rate_limit_event (utilization as a 0..1 fraction, resets in Unix seconds).
 * Returns undefined when the headers carry no valid usage snapshot.
 */
export function parseUsageHeaders(headers: Record<string, string>): UsageResult | undefined {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const window = (abbreviation: string): Window | null | undefined => {
    const raw = lower.get(`${HEADER_PREFIX}-${abbreviation}-utilization`);
    if (raw === undefined) return null;
    const fraction = raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return undefined;
    const reset = Number(lower.get(`${HEADER_PREFIX}-${abbreviation}-reset`));
    return { usedPercent: fraction * 100, resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null };
  };
  const fiveHour = window("5h");
  const weekly = window("7d");
  if (fiveHour === undefined || weekly === undefined || (fiveHour === null && weekly === null)) return undefined;
  return { ok: true, fiveHour, weekly };
}

export async function fetchUsage(configDir: string | null, deps: UsageDependencies = {}): Promise<UsageResult> {
  const readFile = deps.readFile ?? usageDefaults.readFile;
  const fetch = deps.fetch ?? usageDefaults.fetch;
  const now = deps.now ?? usageDefaults.now;
  let token: string;
  try {
    const dir = normalizeConfigDir(configDir) ?? join(homedir(), ".claude");
    const credentials: unknown = JSON.parse(await readFile(join(dir, ".credentials.json"), "utf8"));
    const oauth = record(credentials) ? credentials.claudeAiOauth : undefined;
    if (!record(oauth) || typeof oauth.accessToken !== "string" || !oauth.accessToken.trim() ||
        typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt)) {
      return { ok: false, reason: "unavailable" };
    }
    if (oauth.expiresAt <= now()) return { ok: false, reason: "expired" };
    token = oauth.accessToken;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      return { ok: false, reason: "rate-limited", retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null };
    }
    if (!response.ok) return { ok: false, reason: "http", status: response.status };
  } catch {
    return { ok: false, reason: "http" };
  }
  try {
    const value: unknown = await response.json();
    if (!record(value)) return { ok: false, reason: "invalid" };
    const fiveHour = parseWindow(value.five_hour);
    const weekly = parseWindow(value.seven_day);
    if (fiveHour === undefined || weekly === undefined) return { ok: false, reason: "invalid" };
    return { ok: true, fiveHour, weekly };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export function createUsageCache(deps: UsageDependencies & { ttlMs?: number } = {}) {
  const now = deps.now ?? usageDefaults.now;
  const ttlMs = deps.ttlMs ?? 120_000;
  const cache = new Map<string, { result: UsageResult; expiresAt: number }>();
  // Consecutive rate limits per key; the endpoint is shared with Claude Code and limits aggressively.
  const rateLimits = new Map<string, number>();
  const lifetime = (key: string, result: UsageResult) => {
    if (result.ok || result.reason !== "rate-limited") {
      rateLimits.delete(key);
      return ttlMs;
    }
    const count = (rateLimits.get(key) ?? 0) + 1;
    rateLimits.set(key, count);
    return Math.max(Math.min(300_000 * 2 ** (count - 1), 1_800_000), result.retryAfterMs ?? 0);
  };
  const inFlight = new Map<string, Promise<UsageResult>>();
  return {
    get(accountName: string, configDir: string | null, opts: { force?: boolean } = {}): Promise<UsageResult> {
      const key = `${accountName}\0${configDir ?? ""}`;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const cached = cache.get(key);
      const backingOff = cached && !cached.result.ok && cached.result.reason === "rate-limited";
      if ((!opts.force || backingOff) && cached && cached.expiresAt > now()) return Promise.resolve(cached.result);
      const request = fetchUsage(configDir, deps).then(result => {
        if (inFlight.get(key) === request) {
          cache.set(key, { result, expiresAt: now() + lifetime(key, result) });
        }
        return result;
      }).finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
      inFlight.set(key, request);
      return request;
    },
    /** Stores a result observed elsewhere (provider headers); it wins over any in-flight fetch. */
    record(accountName: string, configDir: string | null, result: UsageResult) {
      const key = `${accountName}\0${configDir ?? ""}`;
      inFlight.delete(key);
      cache.set(key, { result, expiresAt: now() + lifetime(key, result) });
    },
    clear() {
      cache.clear();
      rateLimits.clear();
      inFlight.clear();
    },
  };
}
