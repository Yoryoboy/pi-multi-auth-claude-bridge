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

- [ ] T1 — S1 — inline — commit: pending
- [ ] T2 — S2 — inline — commit: pending
- [ ] T3 — S3 — inline (high risk: moves user data) — commit: pending
- [ ] T4 — S4 — inline — commit: pending
- [ ] T5 — S5 + README — inline — commit: pending
- [ ] T6 — independent verify (S1-S5) + native review per RDD — commit: n/a

## Log

- L1 (2026-10-12, user): "quiero mejorar la experiencia de agregar y configurar una nueva cuenta en este plugin. explicame el proceso actual y dime como lo podemos mejorar para que sea lo mas rapido y amigable posible" → proposal 1-6 given; user: "hagamos todos. 1, 2, 3, 4a y 5".
