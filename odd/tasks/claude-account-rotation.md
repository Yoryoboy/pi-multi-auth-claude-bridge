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
- [x] **ODD-3 — Active account selector and env application**
  - Compute active account; apply/delete `CLAUDE_CONFIG_DIR`; warn when launched with an unregistered value.
  - Acceptance: tests for preference, cooldown expiry, needs-attention, all-unavailable earliest-reset probe.
- [x] **ODD-4 — Error classifier and reset parser**
  - Classes above; locale time parsing; +24h self-correction; 1h fallback.
  - Acceptance: fixture-driven tests for each class and locale formats (`18:30:00`, `6:30:00 PM`).
- [x] **ODD-5 — Extension wiring**
  - Turn-start recompute and capture; `message_end` classify -> cooldown/switch; all-exhausted non-retryable rewrite; status bar and notifications.
  - Acceptance: tests with a fake Pi API; verify replacement is applied before Pi's retry classification.
- [x] **ODD-6 — `/claude-account` command and startup validation**
  - `list|use|add|remove` with name completion; `add` only registers and prints login instructions; background `claude auth status` per account at `session_start`.
  - Acceptance: command tests; logged-out or identity-mismatch accounts are marked unusable.
- [ ] **ODD-7 — Documentation and manual end-to-end checks**
  - README (install, add account, symlink advice, limits, policy risk); manual checklist: mid-session switch, real exhaustion text capture, all-exhausted behavior.
  - Acceptance: checklist executed and results recorded here.

## Follow-ups
- R3-001: fixed in ODD-5 — `onCompromised` no longer throws; in-flight `mutate` rejects with a typed error.
- R3-002: store test coverage advisory; revisit with R3-001.
- R3-cooldown-regression (`reset.ts:40`): the +24h self-correction is applied to every source (epoch, wall time, fallback) whenever `until <= previousUntil`; review whether it should only apply to wall-time probes, and whether one +24h step is enough when `previousUntil` is further ahead.
- runtime.ts:135 advisory: fixed in ODD-6 — "no usable accounts (<name>: needs attention)" message and status.

## Evidence
- ODD-1: `npm install` ok (3 audit warnings, untouched); `npm run typecheck` pass; `npm test` 1/1 pass; `pi -e ./src/index.ts --list-models` exit 0 with no extension errors. No meaningful RED for a no-op scaffold; entry test asserts no registration and no env mutation. Commit: `5650a3c` (`chore: scaffold claude account rotation extension`).
- ODD-2: delegated to `gentle-ai-worker` (store + tests, two non-trivial files). RED: module missing; GREEN: `tests/store.test.ts` 21/21, full suite 22/22; `npm run typecheck` pass. Store at `~/.pi/agent/pi-multi-auth-claude-bridge/state.json`, metadata only. Commit: `afe8457` (`feat(accounts): add shared account state store`). Native review `review-2903551fb2b9c104` (medium, reliability lens): approved and acknowledged; advisory findings R3-001 (`store.ts:265-282`, lock handling) and R3-002 (`store.test.ts:20-100`) recorded as follow-ups.
- ODD-3: delegated to `gentle-ai-worker` (selector, env helper, two test files). RED: modules missing; GREEN: focused 13/13, full suite 35/35; `npm run typecheck` pass. Commit: `b865371` (`feat(accounts): select active account and apply CLAUDE_CONFIG_DIR`). Native review `review-df1da7276ca30e95`: approved, no findings, acknowledged.
- ODD-4: delegated to `gentle-ai-worker` (classifier, reset parser, two test files). RED: modules missing; GREEN: focused 67/67, full suite 102/102; `npm run typecheck` pass. Commit: `a1ff8c0` (`feat(failover): classify Bridge errors and compute cooldowns`). Native review `review-33174fceaf01cfcf`: approved and acknowledged; advisory R3-cooldown-regression (`reset.ts:40`) recorded as follow-up.
- ODD-5: delegated to `gentle-ai-worker`. Verified in installed Pi: per-request event is `context` (`dist/core/sdk.js:266-270`, awaited before provider streaming in `pi-agent-core/dist/agent-loop.js:263-275`, also on retry continuation `agent-session.js:1356-1359`) — so attribution is captured per request, not per turn; `message_end` returning `{ message }` replaces in place (`agent-session.js:907-918`) and the replaced `errorMessage` is what the retry classifier sees (`:1390`); Bridge messages carry `provider === "claude-bridge"`. RED: missing runtime module, wiring failures, missing typed compromise error; extra RED on stale attribution after failover + reload failure. GREEN: focused 43/43, full 123/123; typecheck pass. Commit: `a6ba5f8` (`feat(rotation): wire account failover into Pi events`). Native review `review-b50a319a6571cb7e`: approved and acknowledged; advisory at `runtime.ts:135` recorded as follow-up.
- ODD-6: delegated to `gentle-ai-worker`. `/claude-account list|use|clear|reset|add|remove` with name completions (`types.d.ts:1132-1133,1188`); `reset` added so needs-attention accounts can return; background `claude auth status` per account at session start (local-part identity only, aborted on shutdown). RED: missing modules, wiring/validation failures, empty exhaustion message; GREEN: focused 61/61, full 163/163; typecheck pass. Commit: recorded in the next task entry.
