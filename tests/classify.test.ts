import { describe, expect, it } from "vitest";
import { classifyError } from "../src/failover/classify.js";

const exhausted = (limitType: string | null = null, resetText: string | null = null, resetEpochMs: number | null = null) =>
  ({ kind: "exhausted", limitType, resetText, resetEpochMs });

describe("classifyError", () => {
  it.each(["6:30:00 PM", "18:30:00", "6:30:00 p. m.", "06:30:00 p.m."])("prefers Bridge reset time %s over CLI text", time => {
    expect(classifyError(`Claude rate limit (five_hour) — resets ${time}: You're out of extra usage · resets 6:30pm`))
      .toEqual(exhausted("five_hour", time));
  });

  it.each(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"])("extracts limit type %s", type => {
    expect(classifyError(`Claude rate limit (${type}): rejected`)).toEqual(exhausted(type));
  });

  it.each([
    ["Claude rate limit: rejected", exhausted()],
    ["Claude rate limit — resets 18:30:00: rejected", exhausted(null, "18:30:00")],
    ["You're out of extra usage · resets 6:30pm", exhausted(null, "6:30pm")],
    ["Claude usage limit reached|1760000000", exhausted(null, null, 1760000000000)],
    ["5-hour limit reached ∙ resets 3am", exhausted(null, "3am")],
    ["Usage limit reached", exhausted()],
  ])("classifies exhaustion: %s", (message, expected) => {
    expect(classifyError(message as string)).toEqual(expected);
  });

  it.each([
    "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    "authentication_failed", "account_on_hold", "oauth_org_not_allowed", "billing_error", "verification_required",
    "Claude rate limit (five_hour): API Error: 401",
    "Claude rate limit: billing_error", "usage limit reached: verification_required",
  ])("prioritizes account problem: %s", message => {
    expect(classifyError(message)).toEqual({ kind: "account-problem", reason: expect.any(String) });
    expect((classifyError(message) as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  it.each(["overloaded", "Overloaded", "529", "500", "502", "503", "API Error: 5xx", "429", "rate limit", "API rate limit: 429"])("classifies transient: %s", message => {
    expect(classifyError(message)).toEqual({ kind: "transient" });
  });

  it.each([undefined, "", "unknown error", "request 1401 failed", "request 1500 failed", "Claude usage limit reached|17600000000"])("handles nonmatching/invalid epoch input: %s", message => {
    const result = classifyError(message);
    expect(result).toEqual(message?.includes("usage limit") ? exhausted() : { kind: "other" });
  });
});
