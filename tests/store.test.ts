import { describe, it, expect, vi } from "vitest";
import lockfile from "proper-lockfile";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  AccountStore, StoreValidationError, AccountNotFoundError, StoreLockCompromisedError,
  DuplicateAccountError, addAccount, removeAccount, setPreferred,
  setCooldown, clearCooldown, setNeedsAttention, setIdentity,
  normalizeConfigDir, type StateFile,
} from "../src/accounts/store.js";

const empty = (): StateFile => ({ version: 1, accounts: [], preferred: null, state: {} });
const defaults = { cooldownUntil: null, cooldownReason: null, needsAttention: null, identity: null };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "claude-store-"));
  const path = join(dir, "private", "state.json");
  return { path, store: new AccountStore(path) };
}

describe("account store", () => {
  it("records timer lock compromise without throwing and rejects mutation with a typed error", async () => {
    const { path, store } = await fixture();
    await store.load();
    const before = await readFile(path, "utf8");
    let compromise!: (error: Error) => void;
    const release = vi.fn(async () => { throw Object.assign(new Error("already released"), { code: "ERELEASED" }); });
    const spy = vi.spyOn(lockfile, "lock").mockImplementationOnce(async (_path, options) => {
      compromise = options!.onCompromised!;
      return release;
    });
    let timerError: unknown;
    const cause = Object.assign(new Error("lock changed"), { code: "ECOMPROMISED" });
    try {
      await expect(store.mutate(async current => {
        await new Promise<void>(resolve => setTimeout(() => {
          try { compromise(cause); } catch (error) { timerError = error; }
          resolve();
        }, 0));
        return addAccount(current, "main", null);
      })).rejects.toBeInstanceOf(StoreLockCompromisedError);
      expect(timerError).toBeUndefined();
      expect(release).toHaveBeenCalledOnce();
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      spy.mockRestore();
    }
    await store.mutate(current => addAccount(current, "work", "/work"));
    expect((await store.load()).accounts[0].name).toBe("work");
  });

  it("loads a missing file as an empty default", async () => {
    const { store } = await fixture();
    expect(await store.load()).toEqual(empty());
  });

  it("round trips all metadata with private file and directory modes", async () => {
    const { path, store } = await fixture();
    const next = await store.mutate(current => {
      let result = addAccount(current, "main", null);
      result = setPreferred(result, "main");
      result = setCooldown(result, "main", 12345, "five_hour");
      result = setNeedsAttention(result, "main", "authentication failed");
      return setIdentity(result, "main", "alice");
    });
    expect(await new AccountStore(path).load()).toEqual(next);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
  });

  it("rejects invalid JSON without changing the file", async () => {
    const { path, store } = await fixture();
    await store.load();
    await writeFile(path, "{broken");
    await expect(store.load()).rejects.toBeInstanceOf(StoreValidationError);
    await expect(store.mutate(s => addAccount(s, "work", "/work"))).rejects.toBeInstanceOf(StoreValidationError);
    expect(await readFile(path, "utf8")).toBe("{broken");
  });

  it.each([
    { version: 2, accounts: [], preferred: null, state: {} },
    { ...empty(), accounts: [{ name: "work", configDir: "relative" }] },
    { ...empty(), accounts: [{ name: "work", configDir: "/work" }, { name: "WORK", configDir: "/other" }] },
    { ...empty(), accounts: [{ name: "main", configDir: null }, { name: "other", configDir: null }] },
    { ...empty(), preferred: "missing" },
    { ...empty(), accounts: [{ name: "bad name", configDir: null }] },
    { ...empty(), accounts: [{ name: "main", configDir: null }], state: { main: { ...defaults, cooldownUntil: -1 } } },
    { ...empty(), accounts: [{ name: "main", configDir: null }], state: { main: { ...defaults, identity: 42 } } },
  ])("rejects invalid schema without overwriting: %j", async invalid => {
    const { path, store } = await fixture();
    await store.load();
    const raw = JSON.stringify(invalid);
    await writeFile(path, raw);
    await expect(store.load()).rejects.toBeInstanceOf(StoreValidationError);
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it("normalizes missing account state and prunes orphan state", async () => {
    const { path, store } = await fixture();
    await store.load();
    await writeFile(path, JSON.stringify({ ...empty(), accounts: [{ name: "main", configDir: null }], state: { gone: defaults } }));
    expect((await store.load()).state).toEqual({ main: defaults });
    const next = await store.mutate(s => ({ ...s, state: { ...s.state, gone: defaults } }));
    expect(next.state).toEqual({ main: defaults });
  });

  it("rejects invalid mutations without overwriting valid data", async () => {
    const { path, store } = await fixture();
    await store.mutate(s => addAccount(s, "main", null));
    const raw = await readFile(path, "utf8");
    await expect(store.mutate(s => ({ ...s, preferred: "missing" }))).rejects.toBeInstanceOf(StoreValidationError);
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it("serializes one instance and recovers after a rejected mutation", async () => {
    const { store } = await fixture();
    await expect(store.mutate(s => ({ ...s, preferred: "missing" }))).rejects.toBeInstanceOf(StoreValidationError);
    await Promise.all(Array.from({ length: 4 }, (_, i) =>
      store.mutate(s => addAccount(s, `local-${i}`, `/local-${i}`))));
    expect((await store.load()).accounts).toHaveLength(4);
  });

  it("keeps updates from ten concurrent store instances", async () => {
    const { path } = await fixture();
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      new AccountStore(path).mutate(s => addAccount(s, `account-${i}`, `/claude-${i}`))));
    const result = await new AccountStore(path).load();
    expect(result.accounts.map(a => a.name).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `account-${i}`));
    expect(Object.keys(result.state)).toHaveLength(10);
  });
});

describe("pure account helpers", () => {
  it("trims names and expands ~/ paths, leaving null as default", () => {
    expect(normalizeConfigDir(null)).toBeNull();
    expect(normalizeConfigDir("~/claude-work")).toBe(join(homedir(), "claude-work"));
    expect(addAccount(empty(), " Work_1 ", "~/claude-work").accounts).toEqual([
      { name: "Work_1", configDir: join(homedir(), "claude-work") },
    ]);
    expect(() => normalizeConfigDir("relative")).toThrow(StoreValidationError);
  });

  it("rejects duplicates, invalid names, and two default directories", () => {
    const current = addAccount(empty(), "main", null);
    expect(() => addAccount(current, "MAIN", "/work")).toThrow(DuplicateAccountError);
    expect(() => addAccount(current, "other", null)).toThrow(StoreValidationError);
    for (const name of ["", "  ", "bad name", "a/b"]) {
      expect(() => addAccount(empty(), name, "/work")).toThrow(StoreValidationError);
    }
  });

  it("removes preferred account and its state without mutating input", () => {
    const current = setPreferred(addAccount(empty(), "main", null), "main");
    const before = structuredClone(current);
    expect(removeAccount(current, "main")).toEqual(empty());
    expect(current).toEqual(before);
  });

  it("updates and clears metadata without mutating inputs", () => {
    const initial = addAccount(empty(), "main", null);
    const before = structuredClone(initial);
    let result = setCooldown(initial, "main", 100, "five_hour");
    result = setNeedsAttention(result, "main", "login");
    result = setIdentity(result, "main", "alice");
    expect(result.state.main).toEqual({ cooldownUntil: 100, cooldownReason: "five_hour", needsAttention: "login", identity: "alice" });
    result = clearCooldown(result, "main");
    result = setNeedsAttention(result, "main", null);
    result = setIdentity(result, "main", null);
    expect(result.state.main).toEqual(defaults);
    expect(setPreferred(setPreferred(result, "main"), null).preferred).toBeNull();
    expect(initial).toEqual(before);
    expect(() => setCooldown(initial, "main", NaN, "bad")).toThrow(StoreValidationError);
  });

  it("handles prototype-like names as ordinary state keys", () => {
    const initial = addAccount(empty(), "__proto__", "/proto");
    const result = setIdentity(initial, "__proto__", "alice");
    expect(Object.hasOwn(result.state, "__proto__")).toBe(true);
    expect(result.state["__proto__"].identity).toBe("alice");
    expect(initial.state["__proto__"].identity).toBeNull();
    expect(removeAccount(result, "__proto__")).toEqual(empty());
  });

  it("rejects unknown names in every helper", () => {
    for (const operation of [
      () => removeAccount(empty(), "missing"),
      () => setPreferred(empty(), "missing"),
      () => setCooldown(empty(), "missing", 1, "five_hour"),
      () => clearCooldown(empty(), "missing"),
      () => setNeedsAttention(empty(), "missing", null),
      () => setIdentity(empty(), "missing", null),
    ]) expect(operation).toThrow(AccountNotFoundError);
  });
});
