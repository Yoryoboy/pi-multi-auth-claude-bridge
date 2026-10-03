export type Classification =
  | { kind: "exhausted"; limitType: string | null; resetText: string | null; resetEpochMs: number | null }
  | { kind: "account-problem"; reason: string }
  | { kind: "transient" }
  | { kind: "other" };

export function classifyError(message: string | undefined): Classification {
  if (!message) return { kind: "other" };

  // Account problems must win even when Bridge wraps them in a quota error.
  const accountProblem = message.match(/failed to authenticate|\bauth\b|\bauthentication(?:_failed)?\b|\b401\b|\baccount_on_hold\b|\bbilling\w*\b|\bverification(?:_required)?\b|\boauth_org_not_allowed\b/i);
  if (accountProblem) return { kind: "account-problem", reason: accountProblem[0] };

  const prefix = message.match(/^Claude rate limit(?:\s+\(([^)]+)\))?/i);
  if (prefix || /out of extra usage|usage limit|limit reached/i.test(message)) {
    // Time colons have digits after them; Bridge's separator has whitespace.
    const bridgeReset = prefix
      ? message.match(/—\s*resets\s+(.+?)(?=:\s|$)/i)
      : null;
    const rawReset = message.match(/\bresets\s+([^|·∙\r\n]+)/i);
    const resetText = (bridgeReset?.[1] ?? rawReset?.[1])?.trim() || null;
    const epoch = message.match(/\|(\d{10})(?!\d)/);
    return {
      kind: "exhausted",
      limitType: prefix?.[1] ?? null,
      resetText,
      resetEpochMs: epoch ? Number(epoch[1]) * 1000 : null,
    };
  }

  if (/\boverloaded\b|\b(?:429|529|5\d{2}|5xx)\b|\brate limit\b/i.test(message)) {
    return { kind: "transient" };
  }
  return { kind: "other" };
}
