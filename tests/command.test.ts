import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountCommand } from "../src/command.js";
import { createRotationRuntime } from "../src/runtime.js";
import { createAccountStore, addAccount, setCooldown, setIdentity, setNeedsAttention, setPreferred, type StateFile, type StoreMutation } from "../src/accounts/store.js";
const now = new Date(2026, 0, 2, 12).getTime();
function harness(env: NodeJS.ProcessEnv = {}) {
  let state: StateFile = addAccount(addAccount({ version: 1, accounts: [], preferred: null, state: {} }, "main", null), "work", "/work");
  const store = { load: vi.fn(async () => state), mutate: vi.fn(async (fn: StoreMutation) => { state = await fn(state); return state; }) };
  const notify = vi.fn(); const setStatus = vi.fn(); const check = vi.fn();
  const runtime = createRotationRuntime({ store, env, now: () => now, notify, setStatus });
  const directoryExists = vi.fn(async () => true);
  const command = createAccountCommand({ store, runtime, now: () => now, checkAccount: check, directoryExists });
  const ctx = { hasUI: true, mode: "tui", ui: { notify } } as any;
  return { command, runtime, store, env, notify, setStatus, check, directoryExists, ctx, get state() { return state; }, replace(s: StateFile) { state = s; } };
}
describe("account action dispatcher", () => {
  it("lists priority, applied account, cached identity and states by default", async () => {
    const h = harness(); await h.runtime.onSessionStart();
    h.replace(setPreferred(setIdentity(setCooldown(h.state, "work", now + 3600000, "five_hour"), "main", "alice"), "work"));
    await h.command.handler("", h.ctx);
    const text = h.notify.mock.calls.at(-1)![0];
    expect(text.split("\n")[0]).toContain("work");
    expect(text).toContain("cooldown → 13:00 (five_hour)");
    expect(text).toContain("preferred"); expect(text).toContain("main · default · alice · active");
    h.replace(setNeedsAttention(setNeedsAttention(h.state, "main", "logged out"), "work", "identity changed"));
    await h.command.handler("list", h.ctx);
    expect(h.notify.mock.calls.at(-1)![0]).toContain("logged out");
    expect(h.notify.mock.calls.at(-1)![0]).toContain("needs attention: identity changed");
  });
  it("use is a preference, clear restores order and reset clears both blockers", async () => {
    const h = harness(); await h.runtime.onSessionStart();
    await h.command.handler("use work", h.ctx);
    expect(h.state.preferred).toBe("work"); expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: work");
    h.replace(setNeedsAttention(setCooldown(h.state, "work", now + 3600000, "quota"), "work", "logged out"));
    await h.command.handler("use work", h.ctx); expect(h.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    await h.command.handler("reset work", h.ctx);
    expect(h.state.state.work.needsAttention).toBeNull(); expect(h.state.state.work.cooldownUntil).toBeNull();
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    await h.command.handler("clear", h.ctx);
    expect(h.state.preferred).toBeNull(); expect(h.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
  it("reset forgets the cached identity and re-checks the account so a deliberate re-login is accepted", async () => {
    const h = harness(); await h.runtime.onSessionStart();
    h.replace(setNeedsAttention(setIdentity(h.state, "work", "old"), "work", "identity changed: old -> new"));
    await h.command.handler("reset work", h.ctx);
    expect(h.state.state.work.identity).toBeNull();
    expect(h.check).toHaveBeenCalledWith({ name: "work", configDir: "/work" });
  });
  it("add validates directory, registers only, prints login guidance and checks in background", async () => {
    const h = harness();
    await h.command.handler("add extra /extra", h.ctx);
    expect(h.directoryExists).toHaveBeenCalledWith("/extra");
    expect(h.state.accounts.at(-1)).toEqual({ name: "extra", configDir: "/extra" });
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("env CLAUDE_CONFIG_DIR=/extra claude"), "info");
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("/login"), "info");
    expect(h.check).toHaveBeenCalledWith({ name: "extra", configDir: "/extra" });
    await h.command.handler("remove main", h.ctx);
    await h.command.handler("add personal default", h.ctx);
    expect(h.state.accounts.at(-1)?.configDir).toBeNull();
    expect(h.notify.mock.calls.at(-1)![0]).toContain("Run claude then /login");
  });
  it("persists mutations with a temp-dir store and validates actual directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-command-"));
    const store = createAccountStore(join(dir, "state.json"));
    const env: NodeJS.ProcessEnv = {};
    const notify = vi.fn(); const check = vi.fn();
    const runtime = createRotationRuntime({ store, env, now: () => now, notify, setStatus: vi.fn() });
    const command = createAccountCommand({ store, runtime, now: () => now, checkAccount: check });
    const ctx = { ui: { notify }, hasUI: false, mode: "print" } as any;
    await command.handler(`add work ${dir}`, ctx);
    expect((await store.load()).accounts).toEqual([{ name: "work", configDir: dir }]);
    await runtime.onSessionStart();
    await command.handler("use work", ctx); expect(env.CLAUDE_CONFIG_DIR).toBe(dir);
    await command.handler("reset work", ctx); await command.handler("clear", ctx);
    await command.handler(`add bad ${join(dir, "missing")}`, ctx);
    expect((await store.load()).accounts).toHaveLength(1);
    await command.handler("remove work", ctx); expect((await store.load()).accounts).toEqual([]);
    // add and reset each trigger one background check.
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("remove refreshes selection and preference", async () => {
    const h = harness(); await h.runtime.onSessionStart();
    await h.command.handler("use work", h.ctx); await h.command.handler("remove work", h.ctx);
    expect(h.state.preferred).toBeNull(); expect(h.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
  it.each(["unknown", "use", "clear extra", "add bad", "use work extra", "list extra"])("notifies usage without throwing: %s", async args => {
    const h = harness(); await expect(h.command.handler(args, h.ctx)).resolves.toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "error");
  });
  it.each(["reset missing", "remove missing", "add main /duplicate", "add x relative"])("notifies the failure without usage noise: %s", async args => {
    const h = harness(); await expect(h.command.handler(args, h.ctx)).resolves.toBeUndefined();
    expect(h.notify).toHaveBeenLastCalledWith(expect.not.stringContaining("Usage:"), "error");
  });
  it("rejects missing directories and store errors", async () => {
    const h = harness(); h.directoryExists.mockResolvedValue(false);
    await h.command.handler("add extra /missing", h.ctx); expect(h.state.accounts).toHaveLength(2);
    h.store.load.mockRejectedValue(new Error("store unavailable"));
    await expect(h.command.handler("list", h.ctx)).resolves.toBeUndefined();
    expect(h.notify).toHaveBeenLastCalledWith("store unavailable", "error");
  });
  it.each(["use work", "clear", "reset work"])("guards unmanaged %s", async args => {
    const h = harness({ CLAUDE_CONFIG_DIR: "/foreign" }); await h.runtime.onSessionStart();
    await h.command.handler(args, h.ctx);
    expect(h.store.mutate).not.toHaveBeenCalled(); expect(h.env.CLAUDE_CONFIG_DIR).toBe("/foreign");
    expect(h.notify.mock.calls.at(-1)![0]).toContain("unregistered CLAUDE_CONFIG_DIR");
  });
  it.each(["rpc", "json", "print"])("mutates and only notifies in %s", async mode => {
    const h = harness(); h.ctx.mode = mode; h.ctx.hasUI = false;
    await h.command.handler("use work", h.ctx); expect(h.state.preferred).toBe("work"); expect(h.notify).toHaveBeenCalled();
    await expect(h.command.handler("clear", { hasUI: false } as any)).resolves.toBeUndefined();
  });
  it.each(["use w", "reset w", "remove w"])("completes account names from store: %s", async prefix => {
    const h = harness(); expect(await h.command.getArgumentCompletions!(prefix)).toEqual([{ value: `${prefix.split(" ")[0]} work`, label: "work" }]);
    expect(await h.command.getArgumentCompletions!("add w")).toBeNull();
    h.store.load.mockRejectedValue(new Error("load")); expect(await h.command.getArgumentCompletions!(prefix)).toBeNull();
  });
});
