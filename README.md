# pi-multi-auth-claude-bridge

Pi extension that rotates Claude subscription accounts for [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge).

It switches `process.env.CLAUDE_CONFIG_DIR` between Claude Code config directories, each logged in with `claude /login`. The Bridge reads `process.env` on every query, so no Bridge patch is required. Credentials remain owned by Claude Code; this extension never reads or stores them.

> **Status:** work in progress. See `odd/tasks/claude-account-rotation.md`.

## Policy risk

Anthropic's docs state that Pro/Max usage limits assume ordinary, individual usage and that third-party tools should not intermediate Claude.ai credentials. Rotating subscription accounts may lead to throttling or suspension of every account involved. Use at your own risk.
