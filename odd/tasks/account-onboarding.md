# Account Onboarding

Make adding a Claude account from `/claude-accounts` fast and guided: validated name, suggested directory, optional shared setup, login wait, and a final summary.
Branch: `feat/account-onboarding` (from `main` at `927be66`).

## Specs

- **S1 — Self-healing login state.** User-accepted proposal, verbatim: "Que el estado se arregle solo al loguearte (cambio chico). Cuando `auth status` da ok y el motivo guardado es exactamente `"logged out"`, que limpie el flag y guarde la identidad. El caso "cambió la identidad" tiene que seguir bloqueando. Con esto ya no hace falta el `Reset` manual."
- **S2 — Add-account wizard with defaults.** Verbatim: "Nombre validado con la misma regla que el store, mostrada en el placeholder." / "Ruta sugerida: `~/.claude-<nombre>`, con opciones "Usar sugerida / Default (~/.claude) / Otra ruta…"." / "Si el directorio no existe, que lo cree (con `mkdir` y permisos 0700) en lugar de fallar."
- **S3 — Shared setup from the wizard, confirmed.** Verbatim: "Una pantalla de confirmación que muestre exactamente qué va a hacer: symlink de `settings.json` al de la cuenta default; symlink de `projects/` a la referencia. Si ya existe un `projects/` real, lo mueve a un backup con nombre único y mergea sin pisar nada, la misma lógica que hoy está en el README." / "Nunca tocaría `.credentials.json`, `.claude.json`, `sessions/` ni `plugins/`." / "necesita tests de cada caso (no existe / ya es symlink / es un directorio real / hay conflictos)".
- **S4 — Wait for login (option A).** Verbatim: "el asistente muestra el comando listo para copiar y queda "esperando login", repitiendo `claude auth status` cada pocos segundos hasta que dé ok, con opción de cancelar. Cuando da ok muestra "✓ trabajo@… conectada"." Login is never started by the extension.
- **S5 — Final summary.** Verbatim: "Una sola notificación con nombre, identidad, si `projects/` y `settings` están compartidos, y en qué posición de prioridad quedó la cuenta." README updated: the plugin now changes files, only after confirmation.

## Tasks

- [x] T1 — S1 — inline — commit: `b09c7b5`
- [x] T2 — S2 — inline — commit: `3fcfbe0`
- [x] T3 — S3 — inline (high risk: moves user data) — commit: `a21ab68`
- [x] T4 — S4 — inline — commit: `f665d57`
- [x] T5 — S5 + README — inline — commit: `5daa058`
- [ ] T6 — independent verify (S1-S5) + native review per RDD — commit: n/a

## Log

- L1 (2026-10-12, user): "quiero mejorar la experiencia de agregar y configurar una nueva cuenta en este plugin. explicame el proceso actual y dime como lo podemos mejorar para que sea lo mas rapido y amigable posible" → proposal 1-6 given; user: "hagamos todos. 1, 2, 3, 4a y 5".
- L2 evidence T1: RED `expected 'logged out' to be null`; GREEN 262/262, typecheck pass.
- L3 evidence T2: RED missing `src/add-account.ts`; GREEN 271/271, typecheck pass. Decision: wizard lives in `src/add-account.ts`; suggested and custom dirs are created without an extra prompt (spec S2).
- L4 evidence T3: `src/shared-setup.ts` tests were written first but not run before the module existed (RED = missing module, not observed — deviation recorded). Wizard integration RED observed (5 failing), GREEN 291/291, typecheck pass. Reference = default account, else first registered (`projectsReference`). Backup `<entry>.bak-YYYYMMDD-HHMMSS[-N]`, re-checked before `rename`; merge via `fs.cp` with a filter that never overwrites and counts conflicts; failed link restores the original dir.
- L5 evidence T4: RED 6 failing; GREEN 297/297, typecheck pass. Polls every 3s while a cancelable select (AbortSignal) is open; skip aborts polling; first `unavailable` skips waiting; detected login triggers `runtime.checkAccount` so S1 clears the flag. Menu test now injects `checkAuth` (it previously ran the real `claude` binary once).
- L6 evidence T5: RED 4 summary tests + 1 dispatcher test; GREEN 301/301, typecheck pass. Decision: dispatcher `add` no longer notifies on success (only caller is the wizard, which shows login guidance and one summary). README Setup rewritten around the wizard; manual setup kept as fallback.
- L7 verify round 1 (gentle-ai-verify): S1 pass, S4 pass; S2 partial (default ~/.claude not created), S3 fail (backup check-then-rename race overwrote 30/30; reference alias → symlink cycle ELOOP), S5 partial (decline lost already-shared status); P2 partial reference state after failed link. Fixed in `ce255a4` (exclusive backup container dir, alias detection, default dir creation, decline keeps shared outcomes, merge undo).
- L8 verify round 2: all round-1 defects fixed; new P1 caused by the undo (deleted files it had not created). Fixed in `854ca8b` (undo only unchanged byte-identical copies; rmdir only empty dirs).
- L9 verify round 3: S3 still fail — check-then-unlink window: a writer that swaps a file in between verification and unlink loses it (deterministic interleaving). Inherent to any delete-based undo. Proof exhausted after two correction rounds → user decision: keep narrow-window undo vs. drop undo (never delete; merged copies stay in the reference after a failed link).
