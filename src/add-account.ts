import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isValidAccountName } from "./accounts/store.js";
import type { AccountMenuUI } from "./menu.js";
import type { RotationStore } from "./runtime.js";

export interface AddAccountDependencies {
  store: Pick<RotationStore, "load">;
  ui: AccountMenuUI;
  dispatch: (args: string) => Promise<void>;
  /** Creates the directory and its parents (0700); resolves true when anything was created. */
  ensureDirectory?: (directory: string) => Promise<boolean>;
  homeDir?: string;
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
  const registered = (await deps.store.load()).accounts.find(account => account.name === name);
  if (!registered) return;
}
