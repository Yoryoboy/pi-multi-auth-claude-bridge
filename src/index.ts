import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkAccount, type AuthStatus } from "./auth-status.js";
import { createAccountCommand } from "./command.js";
import { runAccountMenu } from "./menu.js";
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
  const getUsage = deps.getUsage ?? usageCache.get;
  const checkAuth = deps.checkAccount ?? ((account: AccountEntry, signal?: AbortSignal) => checkAccount(account, { env: deps.env, signal }));
  const runtime = createRotationRuntime({
    store,
    getUsage,
    recordUsage: usageCache.record,
    checkSharedProjects: deps.checkSharedProjects ?? checkSharedProjects,
    checkAccount: checkAuth,
    // Queued behind the empty turn so Pi starts a fresh Bridge query on the new account.
    resume: () => pi.sendUserMessage("Continue where you left off.", { deliverAs: "followUp" }),
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
  // pi-claude-bridge rebuilds Claude Code's rate_limit_event as unified rate-limit headers.
  pi.on("after_provider_response", (event, ctx) => {
    context = ctx;
    if (ctx.model?.provider === "claude-bridge") runtime.onProviderResponse(event.headers);
  });
  pi.on("turn_end", (_event, ctx) => {
    context = ctx;
    runtime.refreshUsage();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    context = ctx;
    runtime.onSessionShutdown();
  });
  // Not registered as a slash command: the menu dispatches every account action through it.
  const command = createAccountCommand({ store, runtime, now: deps.now ?? Date.now, checkAccount: runtime.checkAccount });
  pi.registerCommand("claude-accounts", {
    description: "Manage Claude accounts in the interactive TUI",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("/claude-accounts requires the interactive TUI.", "error");
        return;
      }
      context = ctx;
      try {
        await runAccountMenu({
          store, ui: ctx.ui, getUsage,
          checkAuth: (account, signal) => checkAuth(account, signal ?? new AbortController().signal),
          recheck: account => runtime.checkAccount(account),
          now: deps.now ?? Date.now,
          appliedAccountName: () => runtime.appliedAccountName,
          dispatch: args => command.handler(args, ctx),
        });
      } finally {
        await runtime.refresh().catch(() => { /* Store errors must not break advisory refresh. */ });
      }
    },
  });
}
