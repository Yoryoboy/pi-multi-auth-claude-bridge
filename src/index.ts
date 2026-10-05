import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkAccount, type AuthStatus } from "./auth-status.js";
import { createAccountCommand } from "./command.js";
import { checkSharedProjects } from "./projects-check.js";
import { createAccountStore, type AccountEntry } from "./accounts/store.js";
import { createRotationRuntime, type RotationStore } from "./runtime.js";

export interface ExtensionDependencies {
  createStore?: () => RotationStore;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  checkAccount?: (account: AccountEntry, signal: AbortSignal) => Promise<AuthStatus>;
  checkSharedProjects?: typeof checkSharedProjects;
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
  const store = (deps.createStore ?? createAccountStore)();
  const runtime = createRotationRuntime({
    store,
    checkSharedProjects: deps.checkSharedProjects ?? checkSharedProjects,
    checkAccount: deps.checkAccount ?? ((account, signal) => checkAccount(account, { env: deps.env, signal })),
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
  pi.on("session_shutdown", () => {
    runtime.onSessionShutdown();
  });
  const command = createAccountCommand({ store, runtime, now: deps.now ?? Date.now, checkAccount: runtime.checkAccount });
  pi.registerCommand("claude-account", {
    ...command,
    handler: async (args, ctx) => {
      context = ctx;
      await command.handler(args, ctx);
    },
  });
}
