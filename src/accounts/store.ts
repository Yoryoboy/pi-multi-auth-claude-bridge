import { mkdir, rmdir, stat, utimes } from "node:fs";
import { chmod, mkdir as mkdirAsync, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import lockfile from "proper-lockfile";

export interface AccountEntry {
  name: string;
  /** null means delete CLAUDE_CONFIG_DIR, not an explicit ~/.claude path. */
  configDir: string | null;
}

export interface AccountState {
  cooldownUntil: number | null;
  cooldownReason: string | null;
  needsAttention: string | null;
  identity: string | null;
}

export interface StateFile {
  version: 1;
  accounts: AccountEntry[];
  preferred: string | null;
  state: Record<string, AccountState>;
}

export const DEFAULT_STORE_PATH = join(
  homedir(), ".pi", "agent", "pi-multi-auth-claude-bridge", "state.json",
);
const LOCK_UPDATE_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = { retries: 50, minTimeout: 10, maxTimeout: 100 };
const lockFs = { mkdir, rmdir, stat, utimes };

export class StoreValidationError extends Error {
  readonly code = "INVALID_ACCOUNT_STORE";
  constructor(message = "Invalid account store") {
    super(message);
    this.name = "StoreValidationError";
  }
}

export class AccountNotFoundError extends StoreValidationError {
  constructor(name: string) {
    super(`Unknown account: ${name}`);
    this.name = "AccountNotFoundError";
  }
}

export class DuplicateAccountError extends StoreValidationError {
  constructor(name: string) {
    super(`Duplicate account name: ${name}`);
    this.name = "DuplicateAccountError";
  }
}

/** The shared lock was lost; reload before retrying the operation. */
export class StoreLockCompromisedError extends Error {
  readonly code = "STORE_LOCK_COMPROMISED";
  constructor(cause: Error) {
    super("Account store lock was compromised; reload before retrying", { cause });
    this.name = "StoreLockCompromisedError";
  }
}

/** A rename succeeded but a durability step failed. Reload before retrying. */
export class StoreCommitUncertainError extends Error {
  readonly code = "STORE_COMMIT_UNCERTAIN";
  constructor() {
    super("Account store mutation may have committed; reload the store before retrying");
    this.name = "StoreCommitUncertainError";
  }
}

const emptyStore = (): StateFile => ({ version: 1, accounts: [], preferred: null, state: {} });
const emptyState = (): AccountState => ({
  cooldownUntil: null, cooldownReason: null, needsAttention: null, identity: null,
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new StoreValidationError();
}

function validName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z0-9_-]+$/i.test(name);
}

export function normalizeConfigDir(configDir: string | null): string | null {
  if (configDir === null) return null;
  if (typeof configDir !== "string") throw new StoreValidationError("Invalid config directory");
  const expanded = configDir.startsWith("~/") ? join(homedir(), configDir.slice(2)) : configDir;
  if (!isAbsolute(expanded)) throw new StoreValidationError("Config directory must be an absolute path");
  return expanded;
}

/** Validate without changing input, materializing defaults and pruning orphan state. */
function normalizeStore(value: unknown): StateFile {
  if (!record(value)) throw new StoreValidationError();
  assertKeys(value, ["version", "accounts", "preferred", "state"]);
  if (value.version !== 1 || !Array.isArray(value.accounts) || !record(value.state)) {
    throw new StoreValidationError();
  }
  const names = new Set<string>();
  let defaultSeen = false;
  const accounts: AccountEntry[] = value.accounts.map((entry: unknown) => {
    if (!record(entry)) throw new StoreValidationError();
    assertKeys(entry, ["name", "configDir"]);
    if (!validName(entry.name)) throw new StoreValidationError("Invalid account name");
    const key = entry.name.toLowerCase();
    if (names.has(key)) throw new DuplicateAccountError(entry.name);
    names.add(key);
    if (entry.configDir !== null && (typeof entry.configDir !== "string" || !isAbsolute(entry.configDir))) {
      throw new StoreValidationError("Config directory must be an absolute path or null");
    }
    if (entry.configDir === null) {
      if (defaultSeen) throw new StoreValidationError("Only one default config directory is allowed");
      defaultSeen = true;
    }
    return { name: entry.name, configDir: entry.configDir };
  });
  if (value.preferred !== null && !accounts.some(a => a.name === value.preferred)) {
    throw new StoreValidationError("Preferred account must exist");
  }
  const states = value.state;
  const state = Object.fromEntries(accounts.map(account => {
    const entry: unknown = Object.hasOwn(states, account.name) ? states[account.name] : emptyState();
    if (!record(entry)) throw new StoreValidationError();
    assertKeys(entry, ["cooldownUntil", "cooldownReason", "needsAttention", "identity"]);
    const normalized = { ...emptyState(), ...entry };
    if (normalized.cooldownUntil !== null &&
        (typeof normalized.cooldownUntil !== "number" || !Number.isFinite(normalized.cooldownUntil) || normalized.cooldownUntil < 0)) {
      throw new StoreValidationError("Invalid cooldown timestamp");
    }
    for (const field of ["cooldownReason", "needsAttention", "identity"] as const) {
      if (normalized[field] !== null && typeof normalized[field] !== "string") throw new StoreValidationError();
    }
    return [account.name, normalized as AccountState];
  }));
  return { version: 1, accounts, preferred: value.preferred as string | null, state };
}

function requireAccount(store: StateFile, name: string): void {
  if (!store.accounts.some(account => account.name === name)) throw new AccountNotFoundError(name);
}

export function addAccount(store: StateFile, name: string, configDir: string | null): StateFile {
  const trimmed = name.trim();
  if (!validName(trimmed)) throw new StoreValidationError("Invalid account name");
  if (store.accounts.some(account => account.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new DuplicateAccountError(trimmed);
  }
  return normalizeStore({ ...store, accounts: [...store.accounts, { name: trimmed, configDir: normalizeConfigDir(configDir) }] });
}

export function removeAccount(store: StateFile, name: string): StateFile {
  requireAccount(store, name);
  return normalizeStore({
    ...store,
    accounts: store.accounts.filter(account => account.name !== name),
    preferred: store.preferred === name ? null : store.preferred,
  });
}

export function setPreferred(store: StateFile, name: string | null): StateFile {
  if (name !== null) requireAccount(store, name);
  return normalizeStore({ ...store, preferred: name });
}

function updateState(store: StateFile, name: string, patch: Partial<AccountState>): StateFile {
  requireAccount(store, name);
  return normalizeStore({ ...store, state: { ...store.state, [name]: { ...emptyState(), ...store.state[name], ...patch } } });
}

export function setCooldown(store: StateFile, name: string, until: number, reason: string): StateFile {
  return updateState(store, name, { cooldownUntil: until, cooldownReason: reason });
}

export function clearCooldown(store: StateFile, name: string): StateFile {
  return updateState(store, name, { cooldownUntil: null, cooldownReason: null });
}

export function setNeedsAttention(store: StateFile, name: string, reason: string | null): StateFile {
  return updateState(store, name, { needsAttention: reason });
}

export function setIdentity(store: StateFile, name: string, identity: string | null): StateFile {
  return updateState(store, name, { identity });
}

export interface AccountStoreOptions { path?: string }
export type StoreMutation = (store: StateFile) => StateFile | Promise<StateFile>;

export class AccountStore {
  readonly path: string;
  private localMutation: Promise<void> = Promise.resolve();

  constructor(options: string | AccountStoreOptions = {}) {
    this.path = typeof options === "string" ? options : options.path ?? DEFAULT_STORE_PATH;
  }

  async load(): Promise<StateFile> {
    return this.withLock(() => this.readOrInitialize());
  }

  /** Callbacks run under the shared lock: keep them pure, short, and local. */
  async mutate(mutation: StoreMutation): Promise<StateFile> {
    const operation = this.localMutation.then(() => this.withLock(async assertLock => {
      const current = await this.readOrInitialize();
      const next = normalizeStore(await mutation(current));
      assertLock();
      await this.writeAtomically(next);
      return next;
    }));
    this.localMutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readOrInitialize(): Promise<StateFile> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const initial = emptyStore();
      await this.writeAtomically(initial);
      return initial;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoreValidationError("Invalid account store JSON");
    }
    const current = normalizeStore(parsed);
    await chmod(this.path, 0o600);
    return current;
  }

  private async writeAtomically(store: StateFile): Promise<void> {
    const directory = dirname(this.path);
    const temporaryPath = join(directory, `.${basename(this.path)}.${randomUUID()}.tmp`);
    let handle;
    let committed = false;
    let created = false;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(store)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Establish private permissions before rename; the committed file is never permissive.
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
      committed = true;
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (created && !committed) await unlink(temporaryPath).catch(() => undefined);
      if (committed) throw new StoreCommitUncertainError();
      throw error;
    }
  }

  private async withLock<T>(operation: (assertLock: () => void) => Promise<T>): Promise<T> {
    await mkdirAsync(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    // A sibling lock with realpath:false also works before state.json exists.
    let compromised: StoreLockCompromisedError | undefined;
    const assertLock = () => { if (compromised) throw compromised; };
    const release = await lockfile.lock(this.path, {
      lockfilePath: `${this.path}.lock`,
      realpath: false,
      fs: lockFs,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      retries: LOCK_RETRIES,
      // proper-lockfile calls this from a timer: never throw outside the operation.
      onCompromised: error => { compromised ??= new StoreLockCompromisedError(error); },
    });
    try {
      assertLock();
      const result = await operation(assertLock);
      assertLock();
      return result;
    } finally {
      try {
        await release();
      } catch (error) {
        // A compromised lock is already released by proper-lockfile. Preserve
        // the typed compromise error rather than masking it with ERELEASED.
        if (!compromised) throw error;
      }
      assertLock();
    }
  }
}

export function createAccountStore(options: string | AccountStoreOptions = {}): AccountStore {
  return new AccountStore(options);
}
