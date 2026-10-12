import { describe, expect, it, vi } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectory, runAddAccount } from "../src/add-account.js";
import { addAccount, normalizeConfigDir, type StateFile } from "../src/accounts/store.js";

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
  const deps = { ui, store, dispatch, ensureDirectory, homeDir: "/home/u" };
  return { ui, store, dispatch, ensureDirectory, deps, get state() { return state; } };
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

describe("createDirectory", () => {
  it("creates missing parents with mode 0700 and reports whether it created anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "add-account-"));
    const dir = join(root, "a", "b");
    expect(await createDirectory(dir)).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await createDirectory(dir)).toBe(false);
  });
});
