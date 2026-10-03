import { describe, it, expect, vi } from "vitest";
import { createRotationRuntime } from "../src/runtime.js";
import { addAccount, setCooldown, setPreferred, setNeedsAttention, type StateFile, type StoreMutation } from "../src/accounts/store.js";

const now = new Date(2026, 0, 2, 12).getTime();
const time = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, "0")}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`;
const empty = (): StateFile => ({ version: 1, accounts: [], preferred: null, state: {} });
const accounts = () => addAccount(addAccount(empty(), "main", null), "work", "/work");
const error = (errorMessage = "Claude rate limit (five_hour)", provider = "claude-bridge") => ({ role: "assistant", provider, stopReason: "error", errorMessage, content: [] });
function harness(initial = accounts(), env: NodeJS.ProcessEnv = {}) {
  let state = initial;
  const store = {
    load: vi.fn(async () => structuredClone(state)),
    mutate: vi.fn(async (fn: StoreMutation) => { state = await fn(structuredClone(state)); return structuredClone(state); }),
  };
  const notify = vi.fn();
  const setStatus = vi.fn();
  const runtime = createRotationRuntime({ store, env, now: () => now, notify, setStatus });
  return { runtime, store, env, notify, setStatus, get state() { return state; }, replace(next: StateFile) { state = next; } };
}

describe("rotation runtime", () => {
  it("does nothing to env with no accounts and clears status", async () => {
    const h = harness(empty(), { CLAUDE_CONFIG_DIR: "/unregistered" });
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    await h.runtime.onAssistantMessageEnd(error());
    expect(h.env).toEqual({ CLAUDE_CONFIG_DIR: "/unregistered" });
    expect(h.setStatus).toHaveBeenLastCalledWith(undefined);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.store.mutate).not.toHaveBeenCalled();
  });
  it("keeps unregistered launch env unmanaged for this session and warns once", async () => {
    const h = harness(accounts(), { CLAUDE_CONFIG_DIR: "/foreign" });
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    await h.runtime.beforeRequest();
    await h.runtime.onAssistantMessageEnd(error());
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/foreign");
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("unregistered"), "warning");
    expect(h.store.mutate).not.toHaveBeenCalled();
  });
  it("reloads shared selection before every request, including retries", async () => {
    const h = harness();
    await h.runtime.onSessionStart();
    h.replace(setPreferred(h.state, "work"));
    await h.runtime.beforeRequest();
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: work");
    h.replace(setPreferred(h.state, "main"));
    await h.runtime.beforeRequest();
    expect(h.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
  it("cools the captured account and switches without resending", async () => {
    const h = harness();
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    expect(await h.runtime.onAssistantMessageEnd(error())).toBeUndefined();
    expect(h.state.state.main.cooldownUntil).toBe(now + 3_600_000);
    expect(h.state.state.main.cooldownReason).toBe("five_hour");
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    expect(h.notify).toHaveBeenCalledWith(`Claude account "main" exhausted (resets ${time(now + 3_600_000)}) — switched to "work"`, "warning");
    await h.runtime.beforeRequest();
    await h.runtime.onAssistantMessageEnd(error());
    expect(h.state.state.work.cooldownUntil).toBe(now + 3_600_000);
  });
  it("attributes errors to capture even if env and preference change mid-turn", async () => {
    const h = harness();
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    h.env.CLAUDE_CONFIG_DIR = "/work";
    h.replace(setPreferred(h.state, "work"));
    await h.runtime.onAssistantMessageEnd(error());
    expect(h.state.state.main.cooldownUntil).toBe(now + 3_600_000);
    expect(h.state.state.work.cooldownUntil).toBeNull();
  });
  it("rewrites all exhausted errors without retryable language and reports earliest reset", async () => {
    const h = harness(setCooldown(accounts(), "work", now + 7_200_000, "rate_limit"));
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    const message = error();
    const replacement = await h.runtime.onAssistantMessageEnd(message);
    expect(replacement).toEqual({ ...message, errorMessage: `Claude quota exceeded on all accounts — main resets ${time(now + 3_600_000)}, work resets ${time(now + 7_200_000)}` });
    expect(replacement!.errorMessage).not.toMatch(/rate.?limit|overloaded|429|529|5\d{2}/i);
    expect(message.errorMessage).toBe("Claude rate limit (five_hour)");
    expect(h.setStatus).toHaveBeenLastCalledWith(`claude: no accounts · back ${time(now + 3_600_000)}`);
    expect(h.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(h.notify).toHaveBeenLastCalledWith(replacement!.errorMessage, "error");
  });
  it("reports no usable accounts when reset candidates disappear behind attention flags", async () => {
    const h = harness(setNeedsAttention(accounts(), "work", "logged out"));
    await h.runtime.onSessionStart(); await h.runtime.beforeRequest();
    h.replace(setNeedsAttention(h.state, "main", "identity changed"));
    const result = await h.runtime.onAssistantMessageEnd(error());
    expect(result?.errorMessage).toBe("Claude quota exceeded on all accounts — no usable accounts (main: needs attention, work: needs attention)");
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: no usable accounts");
  });
  it("probes earliest reset on a new request and self-corrects rejected probes", async () => {
    const until = now + 3_600_000;
    const h = harness(setCooldown(setCooldown(accounts(), "main", until, "rate_limit"), "work", until + 3_600_000, "rate_limit"));
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: main (probe)");
    await h.runtime.onAssistantMessageEnd(error());
    expect(h.state.state.main.cooldownUntil).toBe(until + 86_400_000);
  });
  it("marks account problems for attention without switching", async () => {
    const h = harness();
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    await h.runtime.onAssistantMessageEnd(error("Failed to authenticate"));
    expect(h.state.state.main.needsAttention).toBe("Failed to authenticate");
    expect(h.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith('Claude account "main" needs attention: Failed to authenticate — rotation stopped for this account', "error");
  });
  it.each([error("overloaded 529"), error("unrecognized"), error(undefined, "anthropic"), { ...error(), stopReason: "stop" }, { ...error(), role: "user" }])("ignores unrelated messages: %j", async message => {
    const h = harness();
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    expect(await h.runtime.onAssistantMessageEnd(message)).toBeUndefined();
    expect(h.store.mutate).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("keeps last env and attribution on request store errors, warning once", async () => {
    const h = harness(setPreferred(accounts(), "work"));
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    h.store.load.mockRejectedValue(new Error("unavailable"));
    await expect(h.runtime.beforeRequest()).resolves.toBeUndefined();
    await expect(h.runtime.beforeRequest()).resolves.toBeUndefined();
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    expect(h.notify).toHaveBeenCalledTimes(1);
    await h.runtime.onAssistantMessageEnd(error());
    expect(h.state.state.work.cooldownUntil).toBe(now + 3_600_000);
  });
  it("captures the last applied failover env when the next request reload fails", async () => {
    const h = harness();
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    await h.runtime.onAssistantMessageEnd(error());
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    h.store.load.mockRejectedValue(new Error("reload"));
    await h.runtime.beforeRequest();
    await h.runtime.onAssistantMessageEnd(error());
    expect(h.state.state.work.cooldownUntil).toBe(now + 3_600_000);
  });
  it("never throws on startup or mutation store failures", async () => {
    const h = harness();
    h.store.load.mockRejectedValueOnce(new Error("startup"));
    await expect(h.runtime.onSessionStart()).resolves.toBeUndefined();
    await h.runtime.beforeRequest();
    h.store.mutate.mockRejectedValue(new Error("write"));
    await expect(h.runtime.onAssistantMessageEnd(error())).resolves.toBeUndefined();
    await expect(h.runtime.onAssistantMessageEnd(error("401"))).resolves.toBeUndefined();
    expect(h.notify.mock.calls.every(call => call[1] === "warning")).toBe(true);
  });
  it("does not mutate without a request capture", async () => {
    const h = harness();
    await h.runtime.onSessionStart();
    await h.runtime.onAssistantMessageEnd(error());
    expect(h.store.mutate).not.toHaveBeenCalled();
  });
});
