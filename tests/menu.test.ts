import { describe, expect, it, vi } from "vitest";
import { runAccountMenu } from "../src/menu.js";
import { addAccount, setCooldown, setIdentity, setNeedsAttention, setPreferred, type StateFile } from "../src/accounts/store.js";
import type { UsageResult } from "../src/usage.js";

function harness(choices: (string | undefined)[] = [undefined], inputs: (string | undefined)[] = [], confirmed = true) {
  let state: StateFile = addAccount({ version: 1, accounts: [], preferred: null, state: {} }, "work", "/work");
  const ui = {
    select: vi.fn(async (_title: string, rows: string[]) => {
      const choice = choices.shift();
      return choice === "ACCOUNT" ? rows[0] : choice;
    }),
    input: vi.fn(async () => inputs.shift()),
    confirm: vi.fn(async () => confirmed),
    notify: vi.fn(),
  };
  const store = { load: vi.fn(async () => state) };
  const dispatch = vi.fn(async (_args: string) => {});
  const getUsage = vi.fn(async (_name: string, _dir: string | null): Promise<UsageResult> => ({ ok: false, reason: "unavailable" }));
  const deps = { ui, store, dispatch, getUsage, now: () => 1_000, appliedAccountName: () => undefined as string | undefined };
  return { ui, store, dispatch, getUsage, deps, replace(next: StateFile) { state = next; }, get state() { return state; } };
}

describe("Claude account menu", () => {
  it("renders priority order, identity/dir, all states and cached limits", async () => {
    const h = harness();
    let state = setIdentity(h.state, "work", "alice");
    for (const name of ["preferred", "cool", "attention", "ready"]) state = addAccount(state, name, name === "preferred" ? null : `/${name}`);
    state = setPreferred(state, "preferred");
    const until = new Date(2026, 0, 1, 13, 45).getTime();
    state = setNeedsAttention(setCooldown(state, "cool", until, "quota"), "attention", "logged out");
    h.replace(state);
    h.deps.appliedAccountName = () => "work";
    h.getUsage.mockImplementation(async name => name === "work" ? {
      ok: true, fiveHour: { usedPercent: 25, resetsAt: null }, weekly: { usedPercent: 60, resetsAt: null },
    } : { ok: false, reason: "http" });
    await runAccountMenu(h.deps);
    expect(h.ui.select).toHaveBeenCalledWith("Claude accounts", [
      "preferred · default (~/.claude) · preferred", "work · alice · active · 5h 25% · wk 60%",
      "cool · /cool · cooldown → 13:45", "attention · /attention · needs attention",
      "ready · /ready · available", "Add account", "Clear preference", "Close",
    ]);
    expect(h.getUsage).toHaveBeenCalledWith("work", "/work");
  });
  it("omits missing windows and failed usage without hiding accounts", async () => {
    const h = harness(["Back", undefined]);
    h.getUsage.mockResolvedValueOnce({ ok: true, fiveHour: null, weekly: { usedPercent: 42, resetsAt: null } })
      .mockRejectedValueOnce(new Error("offline"));
    await runAccountMenu(h.deps);
    expect(h.ui.select.mock.calls[0][1][0]).toBe("work · /work · available · wk 42%");
    expect(h.ui.select.mock.calls[1][1][0]).toBe("work · /work · available");
  });
  it.each([undefined, "Close"])("exits on %s without dispatch", async choice => {
    const h = harness([choice]); await runAccountMenu(h.deps);
    expect(h.dispatch).not.toHaveBeenCalled(); expect(h.store.load).toHaveBeenCalledOnce();
  });
  it.each(["Use", "Reset", "Remove"])("dispatches %s and reloads", async action => {
    const h = harness(["ACCOUNT", action, "Close"]);
    await runAccountMenu(h.deps);
    expect(h.ui.select).toHaveBeenNthCalledWith(2, "work", ["Use", "Reset", "Remove", "Back"]);
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith(`${action.toLowerCase()} work`);
    expect(h.store.load).toHaveBeenCalledTimes(2);
    if (action === "Remove") expect(h.ui.confirm).toHaveBeenCalledWith("Remove account?", expect.stringContaining("work"));
    else expect(h.ui.confirm).not.toHaveBeenCalled();
  });
  it.each(["Back", undefined, "Remove"])("does not dispatch canceled submenu %s", async action => {
    const h = harness(["ACCOUNT", action, "Close"], [], false);
    await runAccountMenu(h.deps); expect(h.dispatch).not.toHaveBeenCalled();
  });
  it("shows clear only with preference and reloads after clearing", async () => {
    const h = harness(["Clear preference", "Close"]); h.replace(setPreferred(h.state, "work"));
    h.dispatch.mockImplementation(async () => { h.replace(setPreferred(h.state, null)); });
    await runAccountMenu(h.deps);
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith("clear");
    expect(h.ui.select.mock.calls[0][1]).toContain("Clear preference");
    expect(h.ui.select.mock.calls[1][1]).not.toContain("Clear preference");
  });
  it("runs the add-account wizard and reloads the menu afterwards", async () => {
    const h = harness(["Add account", "~/.claude-main (suggested)", "Close"], ["main"]);
    h.deps = { ...h.deps, homeDir: "/home/u", ensureDirectory: vi.fn(async () => true),
      checkAuth: vi.fn(async () => ({ kind: "ok" as const, identity: "alice" })), recheck: vi.fn() } as typeof h.deps;
    await runAccountMenu(h.deps);
    expect(h.ui.input).toHaveBeenCalledWith("Account name", "letters, digits, - or _");
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith("add main /home/u/.claude-main");
    expect(h.ui.select).toHaveBeenLastCalledWith("Claude accounts", expect.arrayContaining(["Add account", "Close"]));
  });
});
