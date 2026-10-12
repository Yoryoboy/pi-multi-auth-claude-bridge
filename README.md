# pi-multi-auth-claude-bridge

Pi extension that rotates Claude subscription accounts for [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge).

It switches `process.env.CLAUDE_CONFIG_DIR` between Claude Code config directories, each logged in with `claude /login`. The Bridge reads `process.env` on every query, so no Bridge patch is required. Credentials remain owned by Claude Code: this extension never reads, copies, or refreshes them. It stores only account names, directories, and rotation state.

## Policy risk

Anthropic's docs state that Pro/Max usage limits assume ordinary, individual usage and that third-party tools should not intermediate Claude.ai credentials. Rotating subscription accounts may lead to throttling or suspension of every account involved. Use at your own risk, and keep the account you depend on most out of the rotation.

## How it works

- **Fill-first.** One account is used until it is exhausted. Accounts are never alternated per request, which keeps the prompt cache warm.
- **Per-request selection.** Before every model request (Pi's `context` event, including automatic retries) the extension reloads the shared state, picks the first usable account in priority order, and sets or deletes `CLAUDE_CONFIG_DIR`.
- **Failover.** When a `claude-bridge` reply fails with a usage-limit error, that account gets a cooldown until its reset time and the next account is selected. Pi's built-in retry then runs on the new account.
- **Account problems stop rotation.** Authentication, billing, or account-on-hold errors mark the account as *needs attention* instead of failing over, so a flagged account does not drag the others along.
- **All accounts unavailable.** The error is rewritten as non-retryable (`Claude quota exceeded on all accounts — …`), so Pi does not burn its retries. Nothing is resent automatically. A later request probes the account that resets first.
- **Shared state.** Cooldowns live in `~/.pi/agent/pi-multi-auth-claude-bridge/state.json` (0600, atomic writes, file lock), so every running Pi instance sees them.

The main account uses `default`: the extension deletes `CLAUDE_CONFIG_DIR` instead of pointing it at `~/.claude`, so Claude Code reads `~/.claude.json` exactly as it does without the extension.

## Setup

Register accounts in priority order from `/claude-accounts` → `Add account`. Start with your main account (`default (~/.claude)`), then add each extra account. The wizard:

1. **Name.** Letters, digits, `-` or `_`; names already registered are rejected.
2. **Directory.** Suggests `~/.claude-<name>`; `default (~/.claude)` is offered while no account uses it; `Custom path…` accepts an absolute path or `~/…` without spaces. A missing directory (including `~/.claude`) is created with mode `0700`.
3. **Shared settings and history.** Every account must share `settings.json` (the Bridge loads hooks from the active config directory) and **`projects/`** (the Bridge resumes sessions by id from the active config directory; separate histories break mid-session switching and automatic failover). The reference is the default account, or the first registered account when there is no default. The wizard shows the exact plan and changes nothing until you confirm:
   - a missing entry becomes a symlink to the reference;
   - an existing `settings.json` or `projects/` is moved into a new backup directory `<entry>.bak-YYYYMMDD-HHMMSS/` (created exclusively, so nothing is ever overwritten); files from a moved `projects/` are copied into the reference **without overwriting** existing files (conflicts stay only in the backup); then the symlink is created. If linking fails, the original entry is restored; files already copied into the reference are kept (they are copies, so the extension never deletes data);
   - an entry that already resolves to the same place as the reference (in either direction) is left alone; a symlink pointing elsewhere is left unchanged and reported.

   Stop Claude Code sessions that use the account first. `.credentials.json`, `.claude.json`, `sessions/` and `plugins/` are never touched.
4. **Login.** The extension never starts a login. If the account is not logged in yet, the wizard shows the command to run in another terminal (for example `env CLAUDE_CONFIG_DIR=~/.claude-work claude`, then `/login` inside Claude Code) and waits, checking `claude auth status` every 3 seconds. Choose `Skip — log in later` to close the wait.
5. **Summary.** One notification lists the account's priority, identity, and whether `settings.json` and `projects/` are shared, for example `✓ Claude account "work" added · priority 2 of 2 · logged in as alice · settings.json shared · projects/ shared · created /home/you/.claude-work`.

At session start, every account is checked in the background with `claude auth status`. Logged-out accounts are marked *needs attention*; the flag clears by itself once a later check finds the account logged in. An identity change stays flagged until you `Reset` the account. A separate background check warns once with fix commands when an account's `projects/` directory is not shared; that check never changes files.

### Manual setup

To prepare a directory by hand instead (GNU `cp`; keep the backup for conflicts):

```sh
mkdir -p "$HOME/.claude/projects"
ln -s ~/.claude/settings.json ~/.claude-work/settings.json   # after moving any existing file aside
# If ~/.claude-work/projects already exists, move it aside and merge first:
mv "$HOME/.claude-work/projects" "$HOME/.claude-work/projects.bak" &&
  cp -a --update=none "$HOME/.claude-work/projects.bak/." "$HOME/.claude/projects/" &&
  ln -s "$HOME/.claude/projects" "$HOME/.claude-work/projects"
```

Never link `.credentials.json`, `.claude.json`, `sessions/`, or `plugins/`.

## Menu

`/claude-accounts` (TUI only) opens an arrow-key menu: one row per account with its state and cached limits, plus `Add account`, `Clear preference`, and `Close`. Selecting an account offers `Use`, `Reset`, `Remove` (confirmed), and `Back`.

| Action | Effect |
| --- | --- |
| `Use` | Prefer this account. Automatic failover still applies |
| `Clear preference` | Drop the preference |
| `Reset` | Clear cooldown, needs-attention, and the cached identity, then re-check |
| `Add account` | Guided setup: name, directory, shared settings and history, login wait, summary |
| `Remove` | Remove the account from the registry (its directory is kept) |

The status bar shows `claude: <name> · 5h N% · wk M%`, `claude: <name> · limits unavailable`, `claude: <name> (probe)`, or `claude: no accounts · back HH:MM`. Limits are colored by the higher window: dim up to 75%, warning above 75%, error above 90%.

## Usage limits and credentials

To show limits, the extension reads `claudeAiOauth.accessToken` and `expiresAt` from `<configDir>/.credentials.json` read-only and sends the token only to `https://api.anthropic.com/api/oauth/usage`. It never refreshes, copies, logs, or stores the token; an expired token shows `limits unavailable` until Claude Code renews it. Results are cached for 120 seconds and refreshed at session start, after each turn, and after account changes. The endpoint is undocumented and may change.

If Pi is launched with a `CLAUDE_CONFIG_DIR` that is not registered, the extension warns once and leaves the environment alone for that session.

## Limits

- Detection is reactive. One request fails per exhaustion, and the Bridge does not expose "approaching limit" warnings without a patch.
- Reset times arrive as a local wall-clock time without a date. Weekly limits are corrected by probing: if an account is still rejected after its cooldown, the cooldown moves forward by whole days. Without reset information, a rejected probe backs off one hour.
- AskClaude failures are not used for failover.

## Development

```sh
npm install
npm test
npm run typecheck
```
