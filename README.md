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

1. Log in each extra account in its own config directory:

   ```sh
   env CLAUDE_CONFIG_DIR=$HOME/.claude-work claude
   # inside Claude Code: /login
   ```

2. Keep hooks and settings identical across accounts. The Bridge loads `settings.json` (hooks included) from the active config directory:

   ```sh
   mv ~/.claude-work/settings.json ~/.claude-work/settings.json.bak
   ln -s ~/.claude/settings.json ~/.claude-work/settings.json
   ```

   **`projects/` MUST be symlinked to the default account's `~/.claude/projects/`.** The Bridge resumes sessions by id, and the session files live under the active config directory; separate histories break mid-session switching and automatic failover.

   With Claude Code and Pi stopped, back up any existing history and merge only non-conflicting files before linking (GNU `cp`; keep the backup for conflicts):

   ```sh
   mkdir -p "$HOME/.claude/projects"
   # If projects already exists, first move it aside and merge:
   mv "$HOME/.claude-work/projects" "$HOME/.claude-work/projects.bak" &&
     cp -a --update=none "$HOME/.claude-work/projects.bak/." "$HOME/.claude/projects/" &&
     ln -s "$HOME/.claude/projects" "$HOME/.claude-work/projects"
   # If projects does not exist, only run:
   # ln -s "$HOME/.claude/projects" "$HOME/.claude-work/projects"
   ```

   Use a fresh backup name if `projects.bak` already exists; do not rerun this on an already shared symlink. Without a registered default account, share the first registered account's projects directory instead.

   Never link `.credentials.json`, `.claude.json`, `sessions/`, or `plugins/`.

3. Register the accounts in Pi, in priority order:

   ```
   /claude-account add main default
   /claude-account add work ~/.claude-work
   ```

   `add` only registers the directory; it never starts a login. At session start, every account is checked in the background with `claude auth status`. Logged-out accounts, or accounts whose identity changed, are marked *needs attention*. A separate background check warns once with the offending accounts and symlink fix commands when their `projects/` directories are not shared. It never changes files; use the merge-safe steps above to preserve existing history.

## Command

```
/claude-account [list | use <name> | clear | reset <name> | add <name> <dir|default> | remove <name>]
```

| Subcommand | Effect |
| --- | --- |
| `list` (default) | Accounts in priority order, with identity and state |
| `use <name>` | Prefer this account. Automatic failover still applies |
| `clear` | Drop the preference |
| `reset <name>` | Clear cooldown, needs-attention, and the cached identity, then re-check |
| `add` / `remove` | Manage the registry |

The status bar shows `claude: <name>`, `claude: <name> (probe)`, or `claude: no accounts · back HH:MM`.

If Pi is launched with a `CLAUDE_CONFIG_DIR` that is not registered, the extension warns once and leaves the environment alone for that session.

## Limits

- Detection is reactive. One request fails per exhaustion, and the Bridge does not expose "approaching limit" warnings without a patch.
- Reset times arrive as a local wall-clock time without a date. Weekly limits are corrected by probing: if an account is still rejected after its cooldown, the cooldown moves forward by 24 hours.
- AskClaude failures are not used for failover.

## Development

```sh
npm install
npm test
npm run typecheck
```
