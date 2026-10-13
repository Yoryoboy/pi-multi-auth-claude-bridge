# Failover Resume
Account failover switches accounts but the turn stops; the user must type "continua".
Workaround here, then fix upstream in pi-claude-bridge (issue + linked PR). Branch: `fix/failover-resume`.

## Specs
- S1: "cunaod llega rate limit si cambia de cuenta pero no sigue con el trabajo, tengoque decirle yo que continue" / "ok hagamso el workaroudo para dejalro funcioanando con osotors" — after an automatic account switch, work continues without the user typing "continue".
- S2: "Luego, haz pull en upstream para ver que estemos actualkizado"
- S3: "abramos una issue"
- S4: "pongamos una pull reuqets aosicada  ala issue con la reoslucion al problema" — revised (L8): support existing PR #174 as the resolution instead of a duplicate PR.

## Tasks
- [x] T1 (S1) inline — workaround in this extension: after a switch, an empty `stop` from claude-bridge triggers one follow-up resume message. Commit: a9316a9
- [x] T2 (S2) inline — fork/clone `elidickinson/pi-claude-bridge`, sync with upstream, confirm the bug still exists on latest. Result: fork Yoryoboy/pi-claude-bridge cloned at /home/yoryo/apps/pi-claude-bridge; upstream main b2e7255 (Release 0.9.2) == installed; bug present at src/index.ts:1803.
- [ ] T3 (S3) inline — open upstream issue with the retry-after-failover repro, referencing #174. Link: —
- [ ] T4 (S4) inline — comment on PR #174: it also fixes the retry case; report any verified gap. Link: —

## Log
- L1: "hay un bug mira: Warning: Claude rate limited (five_hour) — resets at 1:40:00 PM ... Warning: Claude account "USA" exhausted (resets 13:40) — switched to "main" ❯ continua o sea cunaod llega rate limit si cambia de cuenta pero no sigue con el trabajo, tengoque decirle yo que continue"
- L2: Evidence (session sunshine-virtual-display 2026-10-13T13:39:59): error rate limit -> context_edit (Pi retry) -> assistant stop, content [], usage 0, durationMs 0. Pi retries; pi-claude-bridge 0.9.2 `src/index.ts:1803` treats the retry (last msg = toolResult, query dead) as an orphaned tool result after abort and emits an empty end_turn.
- L3: Upstream `elidickinson/pi-claude-bridge` is not the user's repo; user has no fork.
- L4: "ok hagamso el workaroudo para dejalro funcioanando con osotors. Luego, haz pull en upstream para ver que estemos actualkizado y abramos una issue y pongamos una pull reuqets aosicada  ala issue con la reoslucion al problema"
- L5: T1 verified: RED 3 failing -> GREEN 316/316, typecheck OK; RDD assess medium, review not due, no separate verifier.
- L6: RDD review lineage review-6d3187b743208ac1 (lens review-reliability, user granted consent) approved; acknowledgement burned authority (gentle-ai.review-acknowledged/v1).
- L7: Upstream already has open PR #174 (jcwasher, "Resume a tool result that arrives after a restart instead of orphaning it"): orphan branch only after an abort observed for that pi session; otherwise fresh query. Same root cause, different trigger (restart). It would also fix our retry case. Related open issues: #183 (make subscription-window rate limits non-retryable — would disable Pi's retry that this extension's failover relies on), #103 (five_hour error nulls sharedSession -> full re-cache). Duplicate issue+PR needs a user decision.
- L8: User chose "Issue + apoyar #174 (recomendado)": open an issue with our repro referencing #174, and comment on #174 that it also covers this case. No duplicate PR.
- L9: Probe (fake SDK, #174 harness; script kept at /tmp/probe/full.mjs). A = retry after a query error at a tool boundary, no abort; B = same retry after an earlier user abort in the session. main 0.9.2: A empty, B empty. PR #174: A fixed, B empty (abortedSessionIds is never cleared). #174 + `abortedSessionIds.delete(sessionId)` at fresh-query start: A and B fixed; unit suite 287/288 with and without it (pre-existing local failure: markStartupNoticeShown creates the config when there is none).
