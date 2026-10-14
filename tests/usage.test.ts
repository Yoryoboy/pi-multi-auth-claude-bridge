import { describe, it, expect, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUsageCache, fetchUsage, parseUsageHeaders } from "../src/usage.js";

const token = "synthetic-secret-token";
const time = Date.parse("2026-10-05T12:00:00Z");
const reset = "2026-10-05T17:00:00Z";
const payload = {
  five_hour: { utilization: 42, resets_at: reset },
  seven_day: { utilization: 18, resets_at: reset },
  ignored: token,
};
const expected = {
  ok: true,
  fiveHour: { usedPercent: 42, resetsAt: Date.parse(reset) },
  weekly: { usedPercent: 18, resetsAt: Date.parse(reset) },
};
function fixture() {
  let clock = time;
  const readFile = vi.fn(async (_path: string, _encoding: "utf8") => JSON.stringify({
    claudeAiOauth: { accessToken: token, expiresAt: time + 360_000 },
  }));
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(payload)));
  const deps = { readFile, fetch, now: () => clock };
  return { ...deps, deps, advance: (ms: number) => { clock += ms; } };
}

function longLived() {
  const f = fixture();
  f.readFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: time + 86_400_000 } }));
  return f;
}

describe("usage fetcher", () => {
  it("reads the resolved directory and returns only usage metadata", async () => {
    const f = fixture();
    const result = await fetchUsage("~/.claude-work", f.deps);
    expect(f.readFile).toHaveBeenCalledWith(join(homedir(), ".claude-work", ".credentials.json"), "utf8");
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(f.fetch).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
  });
  it("resolves the default registry directory", async () => {
    const f = fixture();
    await fetchUsage(null, f.deps);
    expect(f.readFile).toHaveBeenCalledWith(join(homedir(), ".claude", ".credentials.json"), "utf8");
  });
  it.each([time - 1, time])("does not request with an expired token (%s)", async expiresAt => {
    const f = fixture();
    f.readFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }));
    expect(await fetchUsage(null, f.deps)).toEqual({ ok: false, reason: "expired" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["bad json", "null", "{}", JSON.stringify({ claudeAiOauth: { expiresAt: time + 1 } }),
    JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: time + 1 } }),
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: "future" } }),
  ])("rejects unusable credentials without requesting", async credentials => {
    const f = fixture();
    f.readFile.mockResolvedValue(credentials);
    expect(await fetchUsage(null, f.deps)).toEqual({ ok: false, reason: "unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("handles missing credentials without exposing errors", async () => {
    const f = fixture();
    f.readFile.mockRejectedValue(new Error(token));
    expect(await fetchUsage(null, f.deps)).toEqual({ ok: false, reason: "unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("accepts null windows", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(JSON.stringify({ five_hour: null, seven_day: null })));
    expect(await fetchUsage(null, f.deps)).toEqual({ ok: true, fiveHour: null, weekly: null });
  });
  it("returns a null reset for unavailable reset timestamps", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(JSON.stringify({
      five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 100, resets_at: "invalid" },
    })));
    expect(await fetchUsage(null, f.deps)).toEqual({
      ok: true, fiveHour: { usedPercent: 0, resetsAt: null }, weekly: { usedPercent: 100, resetsAt: null },
    });
  });
  it("handles HTTP 401 without returning its body", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(token, { status: 401 }));
    expect(await fetchUsage(null, f.deps)).toEqual({ ok: false, reason: "http", status: 401 });
  });
  it.each([
    [{ "retry-after": "120" }, 120_000], [{ "retry-after": "0" }, null], [{ "retry-after": "soon" }, null], [{}, null],
  ] as const)("reports HTTP 429 as rate limited with retry-after %j", async (headers, retryAfterMs) => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(token, { status: 429, headers }));
    const result = await fetchUsage(null, f.deps);
    expect(result).toEqual({ ok: false, reason: "rate-limited", retryAfterMs });
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it("handles rejected requests without exposing errors", async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error(token));
    expect(await fetchUsage(null, f.deps)).toEqual({ ok: false, reason: "http" });
  });
  it.each([token, "null", "[]", "{}", JSON.stringify({ five_hour: null }),
    JSON.stringify({ five_hour: { utilization: -1 }, seven_day: null }),
    JSON.stringify({ five_hour: { utilization: 101 }, seven_day: null }),
    JSON.stringify({ five_hour: null, seven_day: { utilization: "42" } }),
  ])("rejects malformed response data without exposing it", async body => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(body));
    const result = await fetchUsage(null, f.deps);
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

describe("usage headers", () => {
  const prefix = "anthropic-ratelimit-unified";
  it("reads both unified windows as percentages with millisecond resets", () => {
    expect(parseUsageHeaders({
      [`${prefix}-status`]: "allowed",
      [`${prefix}-5h-utilization`]: "0.25", [`${prefix}-5h-reset`]: "1791584400",
      [`${prefix}-7d-utilization`]: "0.35", [`${prefix}-7d-reset`]: "1791698400",
    })).toEqual({
      ok: true,
      fiveHour: { usedPercent: 25, resetsAt: 1_791_584_400_000 },
      weekly: { usedPercent: 35, resetsAt: 1_791_698_400_000 },
    });
  });
  it("matches header names case-insensitively and reports a missing window as null", () => {
    expect(parseUsageHeaders({ "Anthropic-Ratelimit-Unified-7d-Utilization": "1" }))
      .toEqual({ ok: true, fiveHour: null, weekly: { usedPercent: 100, resetsAt: null } });
  });
  it.each([
    [{}],
    [{ "content-type": "application/json", [`${prefix}-status`]: "allowed" }],
    [{ [`${prefix}-5h-utilization`]: "abc", [`${prefix}-7d-utilization`]: "0.1" }],
    [{ [`${prefix}-5h-utilization`]: "1.5" }],
    [{ [`${prefix}-5h-utilization`]: "-0.1" }],
  ])("ignores headers without a valid usage snapshot %j", headers => {
    expect(parseUsageHeaders(headers)).toBeUndefined();
  });
});

describe("usage cache", () => {
  it("serves a recorded result without fetching until the TTL ends", async () => {
    const f = longLived();
    const cache = createUsageCache(f.deps);
    const recorded = { ok: true as const, fiveHour: { usedPercent: 25, resetsAt: null }, weekly: null };
    cache.record("main", null, recorded);
    f.advance(119_999);
    expect(await cache.get("main", null)).toEqual(recorded);
    expect(f.fetch).not.toHaveBeenCalled();
    f.advance(1);
    expect(await cache.get("main", null)).toEqual(expected);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("lets a recorded result replace an in-flight fetch and a rate-limit backoff", async () => {
    const f = longLived();
    let release!: (response: Response) => void;
    f.fetch.mockImplementationOnce(async () => new Response("", { status: 429 }))
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const cache = createUsageCache(f.deps);
    await cache.get("main", null);
    f.advance(300_000);
    const pending = cache.get("main", null);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    const recorded = { ok: true as const, fiveHour: null, weekly: { usedPercent: 10, resetsAt: null } };
    cache.record("main", null, recorded);
    release(new Response("", { status: 429 }));
    await pending;
    expect(await cache.get("main", null)).toEqual(recorded);
    f.fetch.mockImplementation(async () => new Response("", { status: 429 }));
    f.advance(120_000);
    await cache.get("main", null);
    f.advance(300_000);
    await cache.get("main", null);
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  it("keys cached and in-flight usage by name and config directory", async () => {
    const f = fixture();
    const cache = createUsageCache(f.deps);
    const old = cache.get("main", null);
    const replacement = cache.get("main", "/replacement");
    expect(replacement).not.toBe(old);
    await Promise.all([old, replacement]);
    await cache.get("main", "/third");
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.readFile).toHaveBeenCalledWith("/replacement/.credentials.json", "utf8");
  });
  it("hits within the default TTL and refetches at expiry", async () => {
    const f = fixture();
    const cache = createUsageCache(f.deps);
    expect(await cache.get("main", null)).toEqual(expected);
    f.advance(119_999);
    expect(await cache.get("main", null)).toEqual(expected);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.advance(1);
    await cache.get("main", null);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("caches failures for the configured TTL", async () => {
    const f = fixture();
    f.readFile.mockRejectedValue(new Error(token));
    const cache = createUsageCache({ ...f.deps, ttlMs: 10 });
    expect(await cache.get("main", null)).toEqual({ ok: false, reason: "unavailable" });
    f.advance(9);
    await cache.get("main", null);
    expect(f.readFile).toHaveBeenCalledTimes(1);
    f.advance(1);
    await cache.get("main", null);
    expect(f.readFile).toHaveBeenCalledTimes(2);
  });
  it("backs off exponentially on rate limits, ignores force, and resets after success", async () => {
    const f = longLived();
    f.fetch.mockImplementation(async () => new Response("", { status: 429 }));
    const cache = createUsageCache(f.deps);
    const limited = { ok: false, reason: "rate-limited", retryAfterMs: null };
    for (const [calls, backoff] of [[1, 300_000], [2, 600_000], [3, 1_200_000], [4, 1_800_000], [5, 1_800_000]]) {
      expect(await cache.get("main", null, { force: true })).toEqual(limited);
      expect(f.fetch).toHaveBeenCalledTimes(calls);
      f.advance(backoff - 1);
      expect(await cache.get("main", null, { force: true })).toEqual(limited);
      expect(f.fetch).toHaveBeenCalledTimes(calls);
      f.advance(1);
    }
    f.fetch.mockImplementation(async () => new Response(JSON.stringify(payload)));
    expect(await cache.get("main", null)).toEqual(expected);
    f.fetch.mockImplementation(async () => new Response("", { status: 429 }));
    f.advance(120_000);
    await cache.get("main", null);
    f.advance(299_999);
    await cache.get("main", null);
    expect(f.fetch).toHaveBeenCalledTimes(7);
    f.advance(1);
    await cache.get("main", null);
    expect(f.fetch).toHaveBeenCalledTimes(8);
  });
  it("honors a retry-after longer than the rate-limit backoff", async () => {
    const f = longLived();
    f.fetch.mockImplementation(async () => new Response("", { status: 429, headers: { "retry-after": "900" } }));
    const cache = createUsageCache(f.deps);
    await cache.get("main", null);
    f.advance(899_999);
    await cache.get("main", null);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.advance(1);
    await cache.get("main", null);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps accounts independent and force bypasses a cached result", async () => {
    const f = fixture();
    const cache = createUsageCache(f.deps);
    await cache.get("main", null);
    await cache.get("work", "/accounts/work");
    await cache.get("main", null, { force: true });
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it("shares the same in-flight promise even with force", async () => {
    const f = fixture();
    let release!: (response: Response) => void;
    f.fetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const cache = createUsageCache(f.deps);
    const first = cache.get("main", null);
    expect(cache.get("main", null)).toBe(first);
    expect(cache.get("main", null, { force: true })).toBe(first);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    release(new Response(JSON.stringify(payload)));
    expect(await first).toEqual(expected);
    expect(await cache.get("main", null)).toEqual(expected);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("clear prevents an old in-flight result from replacing newer data", async () => {
    const f = fixture();
    let release!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const cache = createUsageCache(f.deps);
    const old = cache.get("main", null);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    cache.clear();
    expect(await cache.get("main", null)).toEqual(expected);
    release(new Response(JSON.stringify({ five_hour: null, seven_day: null })));
    await old;
    expect(await cache.get("main", null)).toEqual(expected);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("clear invalidates completed entries", async () => {
    const f = fixture();
    const cache = createUsageCache(f.deps);
    await cache.get("main", null);
    cache.clear();
    await cache.get("main", null);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
});
