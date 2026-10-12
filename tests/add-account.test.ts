import { describe, expect, it, vi } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectory, runAddAccount } from "../src/add-account.js";
import { addAccount, normalizeConfigDir, type StateFile } from "../src/accounts/store.js";
import type { SetupOutcome, SetupPlan } from "../src/shared-setup.js";
import type { AuthStatus } from "../src/auth-status.js";
import type { AccountEntry } from "../src/accounts/store.js";

const empty = (): StateFile => ({ version: 1, accounts: [], preferred: null, state: {} });

function harness(choices: (string | undefined)[], inputs: (string | undefined)[], initial = addAccount(empty(), "work", "/work")) {
  let state = initial;
  const ui = {
    select: vi.fn(async (_title: string, _options: string[], _opts?: { signal?: AbortSignal }) => choices.shift()),
    input: vi.fn(async (_title: string, _placeholder?: string) => inputs.shift()),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
  };
  const store = { load: vi.fn(async () => state) };
  // Mirrors the command dispatcher: `add <name> <dir|default>` registers the account.
  const dispatch = vi.fn(async (args: string) => {
    const [, name, dir] = args.split(" ");
    state = addAccount(state, name, dir === "default" ? null : normalizeConfigDir(dir));
  });
  const ensureDirectory = vi.fn(async (_dir: string) => true);
  const sharedSetup = {
    plan: vi.fn(async (configDir: string, referenceDir: string): Promise<SetupPlan> => ({
      configDir, referenceDir,
      steps: [{ item: "projects", kind: "link", target: `${configDir}/projects`, source: `${referenceDir}/projects`, createSource: false }],
    })),
    apply: vi.fn(async (plan: SetupPlan): Promise<SetupOutcome[]> =>
      plan.steps.map(step => ({ item: step.item, ok: true, shared: true, message: "linked" }))),
  };
  const checkAuth = vi.fn(async (_account: AccountEntry, _signal?: AbortSignal): Promise<AuthStatus> => ({ kind: "ok", identity: "alice" }));
  const recheck = vi.fn((_account: AccountEntry) => {});
  const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  const deps = { ui, store, dispatch, ensureDirectory, sharedSetup, checkAuth, recheck, sleep, homeDir: "/home/u" };
  return { ui, store, dispatch, ensureDirectory, sharedSetup, checkAuth, recheck, sleep, deps, get state() { return state; } };
}

describe("add account wizard: name and directory", () => {
  it("shows the store naming rule as the placeholder", async () => {
    const h = harness([], [undefined]);
    await runAddAccount(h.deps);
    expect(h.ui.input).toHaveBeenCalledWith("Account name", "letters, digits, - or _");
  });
  it.each(["", "   ", "two names", "trabajo.2", "año"])("rejects name %j with the store rule before asking for a directory", async name => {
    const h = harness([], [name]);
    await runAddAccount(h.deps);
    expect(h.ui.notify).toHaveBeenCalledExactlyOnceWith("Account name must use only letters, digits, - or _.", "error");
    expect(h.ui.select).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.ensureDirectory).not.toHaveBeenCalled();
  });
  it("rejects a name already registered, case-insensitively", async () => {
    const h = harness([], ["WORK"]);
    await runAddAccount(h.deps);
    expect(h.ui.notify).toHaveBeenCalledExactlyOnceWith('Account "WORK" is already registered.', "error");
    expect(h.ui.select).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it("suggests ~/.claude-<name>, creates it, and registers the expanded path", async () => {
    const h = harness(["~/.claude-personal (suggested)"], [" personal "]);
    await runAddAccount(h.deps);
    expect(h.ui.select).toHaveBeenNthCalledWith(1, "Config dir",
      ["~/.claude-personal (suggested)", "default (~/.claude)", "Custom path…"]);
    expect(h.ensureDirectory).toHaveBeenCalledExactlyOnceWith("/home/u/.claude-personal");
    expect(h.dispatch).toHaveBeenNthCalledWith(1, "add personal /home/u/.claude-personal");
  });
  it("hides the default option when a default account is already registered", async () => {
    const h = harness([undefined], ["extra"], addAccount(empty(), "main", null));
    await runAddAccount(h.deps);
    expect(h.ui.select).toHaveBeenCalledExactlyOnceWith("Config dir", ["~/.claude-extra (suggested)", "Custom path…"]);
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it("registers the default directory without creating anything", async () => {
    const h = harness(["default (~/.claude)"], ["main"]);
    await runAddAccount(h.deps);
    expect(h.ensureDirectory).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenNthCalledWith(1, "add main default");
  });
  it("expands ~ in a custom path and creates it", async () => {
    const h = harness(["Custom path…"], ["alt", "~/claude/alt"]);
    await runAddAccount(h.deps);
    expect(h.ui.input).toHaveBeenNthCalledWith(2, "Config path", "~/.claude-alt");
    expect(h.ensureDirectory).toHaveBeenCalledExactlyOnceWith("/home/u/claude/alt");
    expect(h.dispatch).toHaveBeenNthCalledWith(1, "add alt /home/u/claude/alt");
  });
  it.each([
    ["", "Config path must be nonempty and contain no whitespace."],
    ["/path with spaces", "Config path must be nonempty and contain no whitespace."],
    ["relative/dir", "Config path must be absolute or start with ~/."],
  ])("rejects custom path %j without creating it", async (path, message) => {
    const h = harness(["Custom path…"], ["alt", path]);
    await runAddAccount(h.deps);
    expect(h.ui.notify).toHaveBeenCalledExactlyOnceWith(message, "error");
    expect(h.ensureDirectory).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it("reports a directory creation failure and registers nothing", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    h.ensureDirectory.mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    await runAddAccount(h.deps);
    expect(h.ui.notify).toHaveBeenCalledExactlyOnceWith(
      "Could not create /home/u/.claude-alt: EACCES: permission denied", "error");
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it.each([
    { choices: [], inputs: [undefined] },
    { choices: [undefined], inputs: ["alt"] },
    { choices: ["Custom path…"], inputs: ["alt", undefined] },
  ])("cancels at each step without side effects ($inputs)", async ({ choices, inputs }) => {
    const h = harness(choices, inputs);
    await runAddAccount(h.deps);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.ensureDirectory).not.toHaveBeenCalled();
    expect(h.ui.notify).not.toHaveBeenCalled();
  });
  it("stops when the dispatcher did not register the account", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    h.dispatch.mockImplementationOnce(async () => {});
    await runAddAccount(h.deps);
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.ui.confirm).not.toHaveBeenCalled();
  });
});

describe("add account wizard: shared setup", () => {
  it("confirms the exact plan against the default account and applies it", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"], addAccount(empty(), "main", null));
    await runAddAccount(h.deps);
    expect(h.sharedSetup.plan).toHaveBeenCalledExactlyOnceWith("/home/u/.claude-alt", "/home/u/.claude");
    expect(h.ui.confirm).toHaveBeenCalledExactlyOnceWith('Share settings and history with "main"?', [
      "• projects/: link /home/u/.claude-alt/projects → /home/u/.claude/projects",
      "Stop Claude Code sessions that use this account first.",
      ".credentials.json, .claude.json, sessions/ and plugins/ are never touched.",
    ].join("\n"));
    expect(h.sharedSetup.apply).toHaveBeenCalledOnce();
  });
  it("uses the first registered account as reference when there is no default", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    await runAddAccount(h.deps);
    expect(h.sharedSetup.plan).toHaveBeenCalledExactlyOnceWith("/home/u/.claude-alt", "/work");
    expect(h.ui.confirm).toHaveBeenCalledWith('Share settings and history with "work"?', expect.any(String));
  });
  it("changes nothing when the user declines and warns that switching may fail", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    h.ui.confirm.mockResolvedValueOnce(false);
    await runAddAccount(h.deps);
    expect(h.sharedSetup.apply).not.toHaveBeenCalled();
  });
  it("applies without asking when nothing needs to change", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    h.sharedSetup.plan.mockImplementationOnce(async (configDir, referenceDir) => ({ configDir, referenceDir, steps: [{ item: "projects", kind: "shared" }] }));
    await runAddAccount(h.deps);
    expect(h.ui.confirm).not.toHaveBeenCalled();
    expect(h.sharedSetup.apply).toHaveBeenCalledOnce();
  });
  it("reports failed steps as a warning", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    h.sharedSetup.apply.mockResolvedValueOnce([{ item: "projects", ok: false, shared: false, message: "EPERM; original restored" }]);
    await runAddAccount(h.deps);
    expect(h.ui.notify).toHaveBeenCalledWith('Could not share projects/ for "alt": EPERM; original restored', "warning");
  });
  it.each([
    { label: "the first account", initial: empty(), choice: "~/.claude-alt (suggested)" },
    { label: "the default directory", initial: addAccount(empty(), "work", "/work"), choice: "default (~/.claude)" },
  ])("skips shared setup for $label", async ({ initial, choice }) => {
    const h = harness([choice], ["alt"], initial);
    await runAddAccount(h.deps);
    expect(h.sharedSetup.plan).not.toHaveBeenCalled();
    expect(h.ui.confirm).not.toHaveBeenCalled();
  });
  it("reports a planning failure without aborting the wizard", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    h.sharedSetup.plan.mockRejectedValueOnce(new Error("EACCES"));
    await runAddAccount(h.deps);
    expect(h.ui.notify).toHaveBeenCalledWith('Could not prepare shared settings for "alt": EACCES', "warning");
    expect(h.sharedSetup.apply).not.toHaveBeenCalled();
  });
});

describe("add account wizard: wait for login", () => {
  const WAIT = 'Waiting for "alt" to log in…';
  const SKIP = "Skip — log in later";
  // The waiting dialog stays open until the wizard aborts it.
  const waitingDialog = (h: ReturnType<typeof harness>) => h.ui.select.mockImplementation(async (title, _options, opts) => {
    if (title !== WAIT) return "~/.claude-alt (suggested)";
    return new Promise(resolve => opts!.signal!.addEventListener("abort", () => resolve(undefined)));
  });

  it("confirms an account that is already logged in without waiting", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    await runAddAccount(h.deps);
    expect(h.checkAuth).toHaveBeenCalledExactlyOnceWith({ name: "alt", configDir: "/home/u/.claude-alt" }, expect.any(AbortSignal));
    expect(h.ui.select).not.toHaveBeenCalledWith(WAIT, expect.anything(), expect.anything());
    expect(h.recheck).toHaveBeenCalledExactlyOnceWith({ name: "alt", configDir: "/home/u/.claude-alt" });
  });
  it("shows the login command, polls auth status, and closes the dialog when login succeeds", async () => {
    const h = harness([], ["alt"]);
    waitingDialog(h);
    h.checkAuth.mockResolvedValueOnce({ kind: "logged-out" }).mockResolvedValueOnce({ kind: "logged-out" })
      .mockResolvedValueOnce({ kind: "ok", identity: "alice" });
    await runAddAccount(h.deps);
    expect(h.ui.notify).toHaveBeenCalledWith(
      'Log in "alt": run  env CLAUDE_CONFIG_DIR=/home/u/.claude-alt claude  then /login inside Claude Code.', "info");
    expect(h.ui.select).toHaveBeenCalledWith(WAIT, [SKIP], { signal: expect.any(AbortSignal) });
    expect(h.checkAuth).toHaveBeenCalledTimes(3);
    expect(h.sleep).toHaveBeenCalledWith(3000, expect.any(AbortSignal));
    expect(h.recheck).toHaveBeenCalledExactlyOnceWith({ name: "alt", configDir: "/home/u/.claude-alt" });
  });
  it("keeps polling through transient unavailable results", async () => {
    const h = harness([], ["alt"]);
    waitingDialog(h);
    h.checkAuth.mockResolvedValueOnce({ kind: "logged-out" }).mockResolvedValueOnce({ kind: "unavailable", reason: "auth status timed out" })
      .mockResolvedValueOnce({ kind: "ok", identity: "alice" });
    await runAddAccount(h.deps);
    expect(h.checkAuth).toHaveBeenCalledTimes(3);
    expect(h.recheck).toHaveBeenCalledOnce();
  });
  it("stops polling when the user skips", async () => {
    const h = harness([], ["alt"]);
    h.ui.select.mockImplementation(async title => title === WAIT ? SKIP : "~/.claude-alt (suggested)");
    let pollSignal: AbortSignal | undefined;
    h.checkAuth.mockImplementation(async (_account, signal) => { pollSignal = signal; return { kind: "logged-out" }; });
    h.sleep.mockImplementation((_ms, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    await runAddAccount(h.deps);
    expect(pollSignal?.aborted).toBe(true);
    const calls = h.checkAuth.mock.calls.length;
    await new Promise(r => setTimeout(r, 0));
    expect(h.checkAuth).toHaveBeenCalledTimes(calls);
    expect(h.recheck).not.toHaveBeenCalled();
  });
  it("does not wait when auth status cannot run at all", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    h.checkAuth.mockResolvedValueOnce({ kind: "unavailable", reason: "claude binary not found" });
    await runAddAccount(h.deps);
    expect(h.ui.notify).toHaveBeenCalledWith('Could not check login for "alt": claude binary not found', "warning");
    expect(h.ui.select).toHaveBeenCalledOnce();
    expect(h.recheck).not.toHaveBeenCalled();
  });
  it("uses plain `claude` in the login command for the default directory", async () => {
    const h = harness([], ["main"], empty());
    h.ui.select.mockImplementation(async (title, _options, opts) => title === 'Waiting for "main" to log in…'
      ? new Promise(resolve => opts!.signal!.addEventListener("abort", () => resolve(undefined)))
      : "default (~/.claude)");
    h.checkAuth.mockResolvedValueOnce({ kind: "logged-out" });
    await runAddAccount(h.deps);
    expect(h.ui.notify).toHaveBeenCalledWith('Log in "main": run  claude  then /login inside Claude Code.', "info");
  });
});

describe("add account wizard: summary", () => {
  const last = (h: ReturnType<typeof harness>) => h.ui.notify.mock.calls.at(-1);
  it("summarizes identity, sharing, priority and the created directory", async () => {
    const h = harness(["~/.claude-alt (suggested)"], ["alt"]);
    h.sharedSetup.plan.mockImplementationOnce(async (configDir, referenceDir) => ({ configDir, referenceDir, steps: [
      { item: "settings.json", kind: "link", target: "t", source: "s", createSource: false },
      { item: "projects", kind: "shared" },
    ] }));
    await runAddAccount(h.deps);
    expect(last(h)).toEqual(['✓ Claude account "alt" added · priority 2 of 2 · logged in as alice · settings.json shared · projects/ shared · created /home/u/.claude-alt', "info"]);
  });
  it("warns when sharing was declined and login was skipped", async () => {
    const h = harness([], ["alt"]);
    h.ui.select.mockImplementation(async title => title.startsWith("Waiting") ? "Skip — log in later" : "~/.claude-alt (suggested)");
    h.ensureDirectory.mockResolvedValueOnce(false);
    h.ui.confirm.mockResolvedValueOnce(false);
    h.checkAuth.mockResolvedValue({ kind: "logged-out" });
    h.sleep.mockImplementation((_ms, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    await runAddAccount(h.deps);
    expect(last(h)).toEqual(['Claude account "alt" added · priority 2 of 2 · not logged in yet · settings.json not shared · projects/ not shared', "warning"]);
  });
  it("marks the reference account as the sharing source", async () => {
    const h = harness(["default (~/.claude)"], ["main"]);
    await runAddAccount(h.deps);
    expect(last(h)).toEqual(['✓ Claude account "main" added · priority 2 of 2 · logged in as alice · reference for shared settings.json and projects/', "info"]);
  });
  it("reports login state as unknown when auth status is unavailable", async () => {
    const h = harness(["default (~/.claude)"], ["main"], empty());
    h.checkAuth.mockResolvedValueOnce({ kind: "unavailable", reason: "claude binary not found" });
    await runAddAccount(h.deps);
    expect(last(h)).toEqual(['Claude account "main" added · priority 1 of 1 · login not verified · reference for shared settings.json and projects/', "warning"]);
  });
});

describe("createDirectory", () => {
  it("creates missing parents with mode 0700 and reports whether it created anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "add-account-"));
    const dir = join(root, "a", "b");
    expect(await createDirectory(dir)).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await createDirectory(dir)).toBe(false);
  });
});
