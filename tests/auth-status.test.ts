import { describe, it, expect, vi } from "vitest";
import { checkAccount } from "../src/auth-status.js";

function executor(stdout = "", error: unknown = null) {
  const end = vi.fn();
  const execFile = vi.fn((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(error, stdout, "secret stderr must never escape"));
    return { stdin: { end } };
  });
  return { execFile: execFile as any, spy: execFile, end };
}
describe("auth status", () => {
  it("uses PATH claude, closes stdin, sets isolated env and returns only local identity", async () => {
    const h = executor('{"loggedIn":true,"email":"alice@example.test","token":"never-return"}');
    const env = { CLAUDE_CONFIG_DIR: "/old", PATH: "/bin" };
    expect(await checkAccount({ name: "work", configDir: "/work" }, { env, execFile: h.execFile })).toEqual({ kind: "ok", identity: "alice" });
    expect(h.spy).toHaveBeenCalledWith("claude", ["auth", "status"], expect.objectContaining({ env: { ...env, CLAUDE_CONFIG_DIR: "/work" }, timeout: 15_000 }), expect.any(Function));
    expect(h.end).toHaveBeenCalledOnce();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/old");
  });
  it("deletes config env for default and parses logged out even on nonzero exit", async () => {
    const h = executor('{"loggedIn":false}', new Error("exit 1"));
    expect(await checkAccount({ name: "main", configDir: null }, { env: { CLAUDE_CONFIG_DIR: "/old" }, execFile: h.execFile })).toEqual({ kind: "logged-out" });
    expect(h.spy.mock.calls[0][2].env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });
  it.each([
    ["not JSON full@email.test", null, "non-JSON"],
    ["", { code: "ENOENT" }, "not found"],
    ["", { killed: true }, "timed out"],
    ['{"loggedIn":true}', null, "invalid"],
    ['{"loggedIn":true,"email":"bad"}', null, "invalid"],
  ])("returns safe unavailable reason for %s", async (stdout, error, reason) => {
    const h = executor(stdout, error);
    const result = await checkAccount({ name: "main", configDir: null }, { execFile: h.execFile, env: {} });
    expect(result).toEqual({ kind: "unavailable", reason: expect.stringContaining(reason) });
    expect(JSON.stringify(result)).not.toContain("@");
  });
  it("forwards abort signal", async () => {
    const controller = new AbortController();
    const h = executor("", { name: "AbortError" });
    await checkAccount({ name: "main", configDir: null }, { execFile: h.execFile, env: {}, signal: controller.signal });
    expect(h.spy.mock.calls[0][2].signal).toBe(controller.signal);
  });
});
