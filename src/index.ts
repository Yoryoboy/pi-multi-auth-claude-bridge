import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkAccount, type AuthStatus } from "./auth-status.js";
import { createAccountCommand } from "./command.js";
import { checkSharedProjects } from "./projects-check.js";
import { createAccountStore, type AccountEntry } from "./accounts/store.js";
import { createRotationRuntime, type RotationStore } from "./runtime.js";
import { createUsageCache, type UsageResult } from "./usage.js";

export interface ExtensionDependencies {
  createStore?: () => RotationStore;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  checkAccount?: (account: AccountEntry, signal: AbortSignal) => Promise<AuthStatus>;
  checkSharedProjects?: typeof checkSharedProjects;
  getUsage?: (accountName: string, configDir: string | null) => Promise<UsageResult>;
}

/**
 * Rotates the Claude subscription account used by pi-claude-bridge by switching
 * `process.env.CLAUDE_CONFIG_DIR` between `claude /login` config directories.
 * The Bridge spreads `process.env` into every Claude Code query, so no Bridge
 * patch is needed. Credentials stay owned by Claude Code; usage checks read its
 * existing OAuth token but never store credentials or initiate login.
 */
export default function extension(pi: ExtensionAPI, deps: ExtensionDependencies = {}): void {
  let context: ExtensionContext | undefined;
  const store = (deps.createStore ?? createAccountStore)();
  const usageCache = createUsageCache({ now: deps.now });
  const runtime = createRotationRuntime({
    store,
    getUsage: deps.getUsage ?? usageCache.get,
    checkSharedProjects: deps.checkSharedProjects ?? checkSharedProjects,
    checkAccount: deps.checkAccount ?? ((account, signal) => checkAccount(account, { env: deps.env, signal })),
    now: deps.now ?? Date.now,
    env: deps.env,
    notify: (message, level) => {
      if (context?.hasUI) context.ui.notify(message, level);
    },
    setStatus: (text, level) => {
      if (context?.hasUI) {
        const styled = text !== undefined && level && typeof context.ui.theme?.fg === "function"
          ? context.ui.theme.fg(level, text) : text;
        context.ui.setStatus("claude-accounts", styled);
      }
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
  pi.on("turn_end", (_event, ctx) => {
    context = ctx;
    runtime.refreshUsage();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    context = ctx;
    runtime.onSessionShutdown();
  });
  const command = createAccountCommand({ store, runtime, now: deps.now ?? Date.now, checkAccount: runtime.checkAccount });
  pi.registerCommand("claude-account", {
    ...command,
    handler: async (args, ctx) => {
      context = ctx;
      await command.handler(args, ctx);
      await runtime.refresh().catch(() => { /* Store errors must not break advisory refresh. */ });
    },
  });
}
