import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isValidAccountName, type AccountEntry } from "./accounts/store.js";
import { checkAccount, type AuthStatus } from "./auth-status.js";
import { shellQuote } from "./command.js";
import type { AccountMenuUI } from "./menu.js";
import type { RotationStore } from "./runtime.js";
import { projectsReference } from "./projects-check.js";
import { applySharedSetup, describeSetupPlan, planSharedSetup, type SetupOutcome } from "./shared-setup.js";

export interface AddAccountDependencies {
  store: Pick<RotationStore, "load">;
  ui: AccountMenuUI;
  dispatch: (args: string) => Promise<void>;
  /** Creates the directory and its parents (0700); resolves true when anything was created. */
  ensureDirectory?: (directory: string) => Promise<boolean>;
  homeDir?: string;
  sharedSetup?: { plan: typeof planSharedSetup; apply: typeof applySharedSetup };
  /** Runs `claude auth status` for the account; never starts a login. */
  checkAuth?: (account: AccountEntry, signal?: AbortSignal) => Promise<AuthStatus>;
  /** Re-validates the stored account state after a detected login. */
  recheck?: (account: AccountEntry) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const POLL_MS = 3000;
const SKIP_LOGIN = "Skip — log in later";

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_DIR = "default (~/.claude)";
const CUSTOM_DIR = "Custom path…";

export async function createDirectory(directory: string): Promise<boolean> {
  return await mkdir(directory, { recursive: true, mode: 0o700 }) !== undefined;
}

/** Guided `Add account`: validated name, suggested directory, created on demand. */
export async function runAddAccount(deps: AddAccountDependencies): Promise<void> {
  const homeDir = deps.homeDir ?? process.env.HOME ?? homedir();
  const input = await deps.ui.input("Account name", "letters, digits, - or _");
  if (input === undefined) return;
  const name = input.trim();
  if (!isValidAccountName(name)) {
    deps.ui.notify("Account name must use only letters, digits, - or _.", "error");
    return;
  }
  const state = await deps.store.load();
  if (state.accounts.some(account => account.name.toLowerCase() === name.toLowerCase())) {
    deps.ui.notify(`Account "${name}" is already registered.`, "error");
    return;
  }

  const suggested = `~/.claude-${name}`;
  const suggestedLabel = `${suggested} (suggested)`;
  const hasDefault = state.accounts.some(account => account.configDir === null);
  const choice = await deps.ui.select("Config dir", [suggestedLabel, ...(hasDefault ? [] : [DEFAULT_DIR]), CUSTOM_DIR]);
  if (choice === undefined) return;

  let configDir: string | null;
  if (choice === DEFAULT_DIR) {
    configDir = null;
  } else if (choice === suggestedLabel) {
    configDir = join(homeDir, `.claude-${name}`);
  } else if (choice === CUSTOM_DIR) {
    const path = await deps.ui.input("Config path", suggested);
    if (path === undefined) return;
    // The dispatcher splits on whitespace and cannot represent these paths.
    if (!path || /\s/.test(path)) {
      deps.ui.notify("Config path must be nonempty and contain no whitespace.", "error");
      return;
    }
    const expanded = path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
    if (!isAbsolute(expanded)) {
      deps.ui.notify("Config path must be absolute or start with ~/.", "error");
      return;
    }
    configDir = expanded;
  } else {
    return;
  }
  if (configDir !== null && /\s/.test(configDir)) {
    deps.ui.notify("Config path must be nonempty and contain no whitespace.", "error");
    return;
  }

  if (configDir !== null) {
    try {
      await (deps.ensureDirectory ?? createDirectory)(configDir);
    } catch (error) {
      deps.ui.notify(`Could not create ${configDir}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
  }
  await deps.dispatch(`add ${name} ${configDir ?? "default"}`);
  const registered = await deps.store.load();
  if (!registered.accounts.some(account => account.name === name)) return;
  if (configDir !== null) await shareWithReference(deps, name, configDir, registered.accounts, homeDir);
  await waitForLogin(deps, { name, configDir });
}

/** Polls `claude auth status` while a cancelable dialog is open; resolves the identity once logged in. */
async function waitForLogin(deps: AddAccountDependencies, account: AccountEntry): Promise<string | undefined> {
  const check = deps.checkAuth ?? ((entry: AccountEntry, signal?: AbortSignal) => checkAccount(entry, { signal }));
  const sleep = deps.sleep ?? abortableSleep;
  const polling = new AbortController();
  const first = await check(account, polling.signal)
    .catch((): AuthStatus => ({ kind: "unavailable", reason: "auth status could not start" }));
  if (first.kind === "unavailable") {
    deps.ui.notify(`Could not check login for "${account.name}": ${first.reason}`, "warning");
    return undefined;
  }
  let identity = first.kind === "ok" ? first.identity : undefined;
  if (identity === undefined) {
    const command = account.configDir === null ? "claude" : `env CLAUDE_CONFIG_DIR=${shellQuote(account.configDir)} claude`;
    deps.ui.notify(`Log in "${account.name}": run  ${command}  then /login inside Claude Code.`, "info");
    const dialog = new AbortController();
    const poll = (async () => {
      try {
        while (!polling.signal.aborted) {
          await sleep(POLL_MS, polling.signal);
          const result = await check(account, polling.signal)
            .catch((): AuthStatus => ({ kind: "unavailable", reason: "auth status could not start" }));
          if (polling.signal.aborted) return;
          if (result.kind === "ok") {
            identity = result.identity;
            dialog.abort();
            return;
          }
        }
      } catch { /* Aborted by skip: stop polling silently. */ }
    })();
    await deps.ui.select(`Waiting for "${account.name}" to log in…`, [SKIP_LOGIN], { signal: dialog.signal });
    polling.abort();
    await poll;
    if (identity === undefined) return undefined;
  }
  deps.recheck?.(account);
  return identity;
}

/** Offers to link settings.json and projects/ to the reference account; returns undefined when not offered. */
async function shareWithReference(
  deps: AddAccountDependencies, name: string, configDir: string,
  accounts: { name: string; configDir: string | null }[], homeDir: string,
): Promise<SetupOutcome[] | undefined> {
  const reference = projectsReference(accounts, homeDir);
  if (!reference || reference.account.name === name) return undefined;
  const setup = deps.sharedSetup ?? { plan: planSharedSetup, apply: applySharedSetup };
  const referenceDir = reference.account.configDir ?? join(homeDir, ".claude");
  try {
    const plan = await setup.plan(configDir, referenceDir);
    const { actionable, text } = describeSetupPlan(plan);
    if (actionable && !await deps.ui.confirm(`Share settings and history with "${reference.account.name}"?`, text)) {
      return [];
    }
    const outcomes = await setup.apply(plan);
    for (const outcome of outcomes.filter(outcome => !outcome.ok)) {
      const label = outcome.item === "projects" ? "projects/" : outcome.item;
      deps.ui.notify(`Could not share ${label} for "${name}": ${outcome.message}`, "warning");
    }
    return outcomes;
  } catch (error) {
    deps.ui.notify(`Could not prepare shared settings for "${name}": ${error instanceof Error ? error.message : String(error)}`, "warning");
    return undefined;
  }
}
