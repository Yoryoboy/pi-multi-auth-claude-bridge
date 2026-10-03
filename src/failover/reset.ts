import type { Classification } from "./classify.js";

export const FALLBACK_COOLDOWN_MS = 3_600_000;
const DAY_MS = 24 * FALLBACK_COOLDOWN_MS;
const MAX_COOLDOWN_MS = 8 * DAY_MS;
type Exhausted = Extract<Classification, { kind: "exhausted" }>;

function nextWallTime(text: string | null, now: number): number | null {
  if (!text) return null;
  // Normalize locale AM/PM markers such as "p. m." without accepting junk.
  const normalized = text.trim().replace(/([ap])\s*\.?\s*m\.?$/i, "$1m");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const meridiem = match[4]?.toLowerCase();
  if (minutes > 59 || seconds > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = hours % 12 + (meridiem === "pm" ? 12 : 0);
  } else if (hours > 23 || match[2] === undefined) {
    return null;
  }

  const date = new Date(now);
  date.setHours(hours, minutes, seconds, 0);
  if (date.getTime() <= now) {
    // Calendar arithmetic preserves local wall time across DST changes.
    date.setDate(date.getDate() + 1);
    date.setHours(hours, minutes, seconds, 0);
  }
  return date.getTime();
}

export function computeCooldownUntil(c: Exhausted, now: number, previousUntil: number | null): number {
  let until = c.resetEpochMs !== null && Number.isFinite(c.resetEpochMs) && c.resetEpochMs > now
    ? c.resetEpochMs
    : nextWallTime(c.resetText, now) ?? now + FALLBACK_COOLDOWN_MS;
  if (previousUntil !== null && until <= previousUntil) until += DAY_MS;
  return Math.min(until, now + MAX_COOLDOWN_MS);
}
