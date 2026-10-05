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
  | { ok: false; reason: "unavailable" | "http" | "invalid" };
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
        typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now()) {
      return { ok: false, reason: "unavailable" };
    }
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
    if (!response.ok) return { ok: false, reason: "http" };
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
  const inFlight = new Map<string, Promise<UsageResult>>();
  return {
    get(accountName: string, configDir: string | null, opts: { force?: boolean } = {}): Promise<UsageResult> {
      const pending = inFlight.get(accountName);
      if (pending) return pending;
      const cached = cache.get(accountName);
      if (!opts.force && cached && cached.expiresAt > now()) return Promise.resolve(cached.result);
      const request = fetchUsage(configDir, deps).then(result => {
        if (inFlight.get(accountName) === request) {
          cache.set(accountName, { result, expiresAt: now() + ttlMs });
        }
        return result;
      }).finally(() => {
        if (inFlight.get(accountName) === request) inFlight.delete(accountName);
      });
      inFlight.set(accountName, request);
      return request;
    },
    clear() {
      cache.clear();
      inFlight.clear();
    },
  };
}
