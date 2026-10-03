import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Rotates the Claude subscription account used by pi-claude-bridge by switching
 * `process.env.CLAUDE_CONFIG_DIR` between `claude /login` config directories.
 * The Bridge spreads `process.env` into every Claude Code query, so no Bridge
 * patch is needed. Credentials stay owned by Claude Code; this extension never
 * reads or stores them.
 */
export default function claudeAccountRotation(_pi: ExtensionAPI): void {
  // Wiring lands in later tasks (store, selector, failover, command).
}
