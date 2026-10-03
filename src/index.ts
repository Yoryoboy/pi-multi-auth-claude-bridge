import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAccountStore } from "./accounts/store.js";
import { createRotationRuntime, type RotationStore } from "./runtime.js";

export interface ExtensionDependencies {
  createStore?: () => RotationStore;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Rotates the Claude subscription account used by pi-claude-bridge by switching
 * `process.env.CLAUDE_CONFIG_DIR` between `claude /login` config directories.
 * The Bridge spreads `process.env` into every Claude Code query, so no Bridge
 * patch is needed. Credentials stay owned by Claude Code; this extension never
 * reads or stores them.
 */
export default function extension(pi: ExtensionAPI, deps: ExtensionDependencies = {}): void {
  let context: ExtensionContext | undefined;
  const runtime = createRotationRuntime({
    store: (deps.createStore ?? createAccountStore)(),
    now: deps.now ?? Date.now,
    env: deps.env,
    notify: (message, level) => {
      if (context?.hasUI) context.ui.notify(message, level);
    },
    setStatus: text => {
      if (context?.hasUI) context.ui.setStatus("claude-accounts", text);
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    await runtime.onSessionStart();
  });
  // context runs before each provider call, including native retry continuations.
  pi.on("context", async (_event, ctx) => {
    context = ctx;
    await runtime.beforeRequest();
  });
  pi.on("message_end", async (event, ctx) => {
    context = ctx;
    if (event.message.role !== "assistant") return;
    const message = await runtime.onAssistantMessageEnd(event.message);
    if (message) return { message };
  });
}
