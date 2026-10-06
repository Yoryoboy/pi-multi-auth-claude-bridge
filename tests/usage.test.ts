import { describe, it, expect, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUsageCache, fetchUsage } from "../src/usage.js";

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
    expect(await fetchUsage(null, f.deps)).toEqual({ ok: false, reason: "unavailable" });
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
    expect(await fetchUsage(null, f.deps)).toEqual({ ok: false, reason: "http" });
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

describe("usage cache", () => {
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
