import { resolve } from "node:path";
import type { AccountEntry, StateFile } from "./accounts/store.js";

export const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

export function applyAccountEnv(
  account: AccountEntry | null,
  env: NodeJS.ProcessEnv = process.env,
): { changed: boolean; previous: string | undefined } {
  const previous = env[CONFIG_DIR_ENV];
  if (account === null) return { changed: false, previous };
  if (account.configDir === null) {
    delete env[CONFIG_DIR_ENV];
    return { changed: previous !== undefined, previous };
  }
  env[CONFIG_DIR_ENV] = account.configDir;
  return { changed: previous !== account.configDir, previous };
}

export function accountForEnv(
  store: StateFile,
  env: NodeJS.ProcessEnv = process.env,
): AccountEntry | { unregistered: string | undefined } {
  const value = env[CONFIG_DIR_ENV];
  // resolve removes redundant segments and trailing slashes while preserving root.
  const normalized = value === undefined ? null : resolve(value);
  const account = store.accounts.find(entry =>
    entry.configDir === null ? normalized === null : resolve(entry.configDir) === normalized,
  );
  return account ?? { unregistered: value };
}
