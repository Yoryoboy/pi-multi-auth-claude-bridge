import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { StateFile } from "../src/accounts/store.js";
import { accountForEnv, applyAccountEnv, CONFIG_DIR_ENV } from "../src/env.js";

const main = { name: "main", configDir: null };
const work = { name: "work", configDir: "/claude/work" };
const store: StateFile = { version: 1, accounts: [main, work], preferred: null, state: {} };

describe("account env", () => {
  it("exports the bridge environment variable name", () => {
    expect(CONFIG_DIR_ENV).toBe("CLAUDE_CONFIG_DIR");
  });

  it("sets the directory and reports previous value and exact-value no-op", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "/old", KEEP: "yes" };
    expect(applyAccountEnv(work, env)).toEqual({ changed: true, previous: "/old" });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: work.configDir, KEEP: "yes" });
    expect(applyAccountEnv(work, env)).toEqual({ changed: false, previous: work.configDir });
    expect(applyAccountEnv(work, {})).toEqual({ changed: true, previous: undefined });
  });

  it("deletes the variable for the default account, including a second no-op", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "", KEEP: "yes" };
    expect(applyAccountEnv(main, env)).toEqual({ changed: true, previous: "" });
    expect(env).toEqual({ KEEP: "yes" });
    expect(Object.hasOwn(env, CONFIG_DIR_ENV)).toBe(false);
    expect(applyAccountEnv(main, env)).toEqual({ changed: false, previous: undefined });
  });

  it("leaves the environment untouched when no account is selected", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "/external" };
    expect(applyAccountEnv(null, env)).toEqual({ changed: false, previous: "/external" });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/external" });
    expect(applyAccountEnv(null, {})).toEqual({ changed: false, previous: undefined });
  });

  it("maps an unset variable to the default account", () => {
    expect(accountForEnv(store, {})).toEqual(main);
    expect(accountForEnv({ ...store, accounts: [work] }, {})).toEqual({ unregistered: undefined });
  });

  it("matches registered paths after normalization on both sides", () => {
    for (const value of ["/claude/work", "/claude/work///", "/claude/other/../work/"]) {
      const env = { CLAUDE_CONFIG_DIR: value };
      expect(accountForEnv(store, env)).toEqual(work);
      expect(env.CLAUDE_CONFIG_DIR).toBe(value);
    }
    const normalizedStore = { ...store, accounts: [{ ...work, configDir: "/claude/other/../work/" }] };
    expect(accountForEnv(normalizedStore, { CLAUDE_CONFIG_DIR: "/claude/work" })).toEqual(normalizedStore.accounts[0]);
    const relativeStore = { ...store, accounts: [{ ...work, configDir: resolve("account-config") }] };
    expect(accountForEnv(relativeStore, { CLAUDE_CONFIG_DIR: "account-config/" })).toEqual(relativeStore.accounts[0]);
  });

  it("returns the original unregistered value, not its normalized path", () => {
    expect(accountForEnv(store, { CLAUDE_CONFIG_DIR: "/external/" })).toEqual({ unregistered: "/external/" });
    expect(accountForEnv(store, { CLAUDE_CONFIG_DIR: "" })).toEqual({ unregistered: "" });
  });
});
