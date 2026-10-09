import { describe, expect, it } from "vitest";
import type { Classification } from "../src/failover/classify.js";
import { computeCooldownUntil, FALLBACK_COOLDOWN_MS } from "../src/failover/reset.js";

type Exhausted = Extract<Classification, { kind: "exhausted" }>;
const hour = 3_600_000;
const day = 24 * hour;
const now = new Date(2026, 9, 3, 12, 0, 0, 0).getTime();
function wallTime(hours: number, minutes = 0, seconds = 0, tomorrow = false): number {
  const date = new Date(now);
  if (tomorrow) date.setDate(date.getDate() + 1);
  date.setHours(hours, minutes, seconds, 0);
  return date.getTime();
}
function quota(resetText: string | null, resetEpochMs: number | null = null, limitType = "five_hour"): Exhausted {
  return { kind: "exhausted", limitType, resetText, resetEpochMs };
}

describe("computeCooldownUntil", () => {
  it.each(["18:30:00", "6:30:00 PM", "6:30:00 p. m.", "06:30:00 p.m.", "6:30pm", "18:30"])("parses local wall time %s", text => {
    expect(computeCooldownUntil(quota(text), now, null)).toBe(wallTime(18, 30));
  });

  it.each([
    ["3am", 3, 0], ["6:30:00 AM", 6, 30], ["12am", 0, 0], ["12pm", 12, 0],
  ] as const)("rolls past or equal time %s to tomorrow", (text, h, m) => {
    expect(computeCooldownUntil(quota(text), now, null)).toBe(wallTime(h, m, 0, true));
  });

  it("retains seconds and maps 12 PM to noon", () => {
    expect(computeCooldownUntil(quota("12:00:01 PM"), now, null)).toBe(wallTime(12, 0, 1));
  });

  it("prefers a future epoch and ignores an expired epoch", () => {
    expect(computeCooldownUntil(quota("18:30", now + 2 * hour), now, null)).toBe(now + 2 * hour);
    for (const epoch of [now, now - 1]) {
      expect(computeCooldownUntil(quota("18:30", epoch), now, null)).toBe(wallTime(18, 30));
    }
  });

  it.each([null, "", "not a time", "25:00", "13pm", "0am", "18:60", "18:30:60", "6:30 garbage"])("falls back for %s", text => {
    expect(FALLBACK_COOLDOWN_MS).toBe(hour);
    expect(computeCooldownUntil(quota(text), now, null)).toBe(now + hour);
  });

  it.each(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"])("self-corrects stale cooldown for %s by 24h", type => {
    const computed = wallTime(18, 30);
    expect(computeCooldownUntil(quota("18:30", null, type), now, computed + hour)).toBe(computed + day);
    expect(computeCooldownUntil(quota("18:30", null, type), now, computed - 1)).toBe(computed);
  });

  it("keeps a cooldown that a probe before its expiry reports again", () => {
    // Probe at 23:09 while the cooldown ends at 23:10; the limit still says "resets 11:10pm".
    const probeAt = wallTime(23, 9);
    const previous = wallTime(23, 10);
    expect(computeCooldownUntil(quota("11:10pm"), probeAt, previous)).toBe(previous);
    expect(computeCooldownUntil(quota("18:30"), now, wallTime(18, 30))).toBe(wallTime(18, 30));
  });

  it("keeps rolling wall time by whole days until it reaches the previous cooldown", () => {
    const computed = wallTime(18, 30);
    expect(computeCooldownUntil(quota("18:30"), now, computed + 2 * day)).toBe(computed + 2 * day);
    expect(computeCooldownUntil(quota("18:30"), now, computed + 2 * day + hour)).toBe(computed + 3 * day);
  });

  it("never self-corrects an epoch or fallback cooldown", () => {
    expect(computeCooldownUntil(quota(null, now + 2 * hour), now, now + 5 * hour)).toBe(now + 2 * hour);
    expect(computeCooldownUntil(quota(null), now, now - hour)).toBe(now + hour);
  });

  it("steps a fallback cooldown one hour past a stale cooldown", () => {
    expect(computeCooldownUntil(quota(null), now, now + hour)).toBe(now + 2 * hour);
  });

  it("clamps epoch and self-correction to eight days", () => {
    expect(computeCooldownUntil(quota(null, now + 20 * day), now, null)).toBe(now + 8 * day);
    expect(computeCooldownUntil(quota(null, now + 8 * day), now, now + 8 * day)).toBe(now + 8 * day);
  });
});
