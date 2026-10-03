# Claude Account Rotation

## Objective
Pi extension that switches the Claude subscription account used by `pi-claude-bridge` by setting `process.env.CLAUDE_CONFIG_DIR`, with sticky automatic failover when an account is exhausted. No Bridge patch.

## Status
Implementation authorized 2026-10-03. Branch: `feat/claude-account-rotation`.

## Verified premises
- Bridge 0.9.1 spreads `process.env` per query in all paths: provider `index.ts:1972`, AskClaude `:2246`, compaction `:586`. No prewarm, no cached auth.
- Bridge reads `CLAUDE_CONFIG_DIR` live for its session mirror (`index.ts:225`, `:835`, `:2074`).
- CLI 2.1.287: env credentials override stored login; `CLAUDE_CONFIG_DIR=~/.claude-work` authenticates as the second account (CLI and end-to-end through Pi/Bridge).
- Rejected rate limits surface in Pi as `errorMessage` starting with `Claude rate limit (<type>) — resets <toLocaleTimeString>: <cc text>` (`index.ts:534-538`).
- Pi `message_end` fires before the auto-retry decision; Pi retries rate-limit errors (3 attempts, 2s base).
- `~/.claude-work/settings.json` symlinked to `~/.claude/settings.json` (hook parity).

## Design decisions
- Credentials stay owned by Claude Code (`/login` per config dir). The extension stores no secrets: only `name -> configDir` plus state.
- Main account uses `configDir: null` => `delete process.env.CLAUDE_CONFIG_DIR` (never point to `~/.claude`, because `~/.claude/.claude.json` also exists).
- Fill-first: one account until exhausted; never round-robin (prompt-cache affinity).
- `/claude-account use <name>` is a preference (moves to front); auto-failover still applies.
- Active account is computed: first account in priority order not in cooldown, not needs-attention, not logged out. Recomputed at each turn start from a shared state file (atomic write + lock) so multiple Pi instances share cooldowns.
- The error is attributed to the account captured at turn start.
- Error classes (when in doubt, do not rotate):
  - exhausted: `^Claude rate limit`, fallback `out of extra usage|usage limit` -> cooldown + switch env so Pi's native retry uses the next account;
  - account problem: `Failed to authenticate|401|account_on_hold|billing` -> needs-attention, no failover, notify;
  - transient: `overloaded|529|5xx` -> no action;
  - other -> no action.
- Reset parsing: locale time -> next occurrence; if still rejected on probe, +24h; unparseable -> fixed 1h cooldown.
- All accounts unavailable: rewrite the error in `message_end` to a non-retryable text (`Claude quota exceeded on all accounts — <resets>`), notify, status `claude: no accounts · back HH:MM`. No auto-resend. A new turn probes the earliest-reset account.
- Out of scope: proactive `allowed_warning` switching (needs Bridge patch), AskClaude failure detection, provider/model switching, login flows.

## Constraints
- Do not modify `pi-claude-bridge` or Claude Code.
- Never read or copy `.credentials.json` contents; never set `CLAUDE_CODE_OAUTH_TOKEN`.
- Follow `pi-multi-auth-codex` conventions: TypeScript ESM, Vitest, `proper-lockfile`, `pi.extensions` entry.
- Generated technical artifacts in English.
- Project is not yet a Git repository; ODD-1 initializes it. Commits only per work unit once implementation is authorized.

## TDD
- Mode: enabled for store, selector, classifier, reset parser and extension wiring (deterministic, Vitest).
- Not applicable: live account exhaustion and mid-session switch — manual checks in ODD-7.

## Tasks
- [x] **ODD-1 — Scaffold the package**
  - `git init`, `package.json`, `tsconfig.json`, Vitest, `pi.extensions` entry, README skeleton.
  - Acceptance: `npm run typecheck` and an empty `npm test` pass; extension loads in Pi as a no-op.
- [x] **ODD-2 — Account registry and shared state store**
  - Accounts (`name`, `configDir|null`, order), preference, cooldowns, needs-attention; file mode 0600, atomic write + lock; no secrets.
  - Acceptance: tests for round-trip, concurrent writers, invalid file recovery.
- [ ] **ODD-3 — Active account selector and env application**
  - Compute active account; apply/delete `CLAUDE_CONFIG_DIR`; warn when launched with an unregistered value.
  - Acceptance: tests for preference, cooldown expiry, needs-attention, all-unavailable earliest-reset probe.
- [ ] **ODD-4 — Error classifier and reset parser**
  - Classes above; locale time parsing; +24h self-correction; 1h fallback.
  - Acceptance: fixture-driven tests for each class and locale formats (`18:30:00`, `6:30:00 PM`).
- [ ] **ODD-5 — Extension wiring**
  - Turn-start recompute and capture; `message_end` classify -> cooldown/switch; all-exhausted non-retryable rewrite; status bar and notifications.
  - Acceptance: tests with a fake Pi API; verify replacement is applied before Pi's retry classification.
- [ ] **ODD-6 — `/claude-account` command and startup validation**
  - `list|use|add|remove` with name completion; `add` only registers and prints login instructions; background `claude auth status` per account at `session_start`.
  - Acceptance: command tests; logged-out or identity-mismatch accounts are marked unusable.
- [ ] **ODD-7 — Documentation and manual end-to-end checks**
  - README (install, add account, symlink advice, limits, policy risk); manual checklist: mid-session switch, real exhaustion text capture, all-exhausted behavior.
  - Acceptance: checklist executed and results recorded here.

## Evidence
- ODD-1: `npm install` ok (3 audit warnings, untouched); `npm run typecheck` pass; `npm test` 1/1 pass; `pi -e ./src/index.ts --list-models` exit 0 with no extension errors. No meaningful RED for a no-op scaffold; entry test asserts no registration and no env mutation. Commit: `5650a3c` (`chore: scaffold claude account rotation extension`).
- ODD-2: delegated to `gentle-ai-worker` (store + tests, two non-trivial files). RED: module missing; GREEN: `tests/store.test.ts` 21/21, full suite 22/22; `npm run typecheck` pass. Store at `~/.pi/agent/pi-multi-auth-claude-bridge/state.json`, metadata only. Commit: recorded in the next task entry.
