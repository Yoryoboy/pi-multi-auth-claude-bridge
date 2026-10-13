import { describe, it, expect, vi } from "vitest";
import type { UsageResult } from "../src/usage.js";
import { createRotationRuntime } from "../src/runtime.js";
import type { ProjectsIssue } from "../src/projects-check.js";
import { addAccount, setCooldown, setPreferred, setNeedsAttention, type StateFile, type StoreMutation } from "../src/accounts/store.js";

const now = new Date(2026, 0, 2, 12).getTime();
const time = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, "0")}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`;
const empty = (): StateFile => ({ version: 1, accounts: [], preferred: null, state: {} });
const accounts = () => addAccount(addAccount(empty(), "main", null), "work", "/work");
const error = (errorMessage = "Claude rate limit (five_hour)", provider = "claude-bridge") => ({ role: "assistant", provider, stopReason: "error", errorMessage, content: [] });
function harness(initial = accounts(), env: NodeJS.ProcessEnv = {}, checkSharedProjects = vi.fn(async (): Promise<ProjectsIssue[]> => []), getUsage?: (name: string, configDir: string | null) => Promise<UsageResult>) {
  let state = initial;
  const store = {
    load: vi.fn(async () => structuredClone(state)),
    mutate: vi.fn(async (fn: StoreMutation) => { state = await fn(structuredClone(state)); return structuredClone(state); }),
  };
  const notify = vi.fn();
  const setStatus = vi.fn();
  const resume = vi.fn();
  const runtime = createRotationRuntime({ store, env, now: () => now, notify, setStatus, resume, checkSharedProjects, getUsage });
  return { runtime, store, env, notify, setStatus, resume, get state() { return state; }, replace(next: StateFile) { state = next; } };
}

describe("rotation runtime", () => {
  it.each([
    [42.6, 18.2, "5h 43% · wk 18%", "dim"],
    [75, 0, "5h 75% · wk 0%", "dim"],
    [0, 75.1, "5h 0% · wk 75%", "warning"],
    [90, 0, "5h 90% · wk 0%", "warning"],
    [0, 90.1, "5h 0% · wk 90%", "error"],
    [null, 40, "5h -- · wk 40%", "dim"],
    [20, null, "5h 20% · wk --", "dim"],
    [null, null, "5h -- · wk --", "dim"],
  ] as const)("formats usage %s/%s with %s and %s", async (five, week, text, level) => {
    const getUsage = vi.fn(async (): Promise<UsageResult> => ({ ok: true,
      fiveHour: five === null ? null : { usedPercent: five, resetsAt: null },
      weekly: week === null ? null : { usedPercent: week, resetsAt: null },
    }));
    const h = harness(accounts(), {}, undefined, getUsage);
    await h.runtime.onSessionStart();
    await vi.waitFor(() => expect(h.setStatus).toHaveBeenLastCalledWith(`claude: main · ${text}`, level));
    expect(getUsage).toHaveBeenCalledWith("main", null);
    await h.runtime.beforeRequest();
    expect(h.setStatus).toHaveBeenLastCalledWith(`claude: main · ${text}`, level);
    expect(getUsage).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("renders unavailable including rejected usage (%s) and preserves probe", async reject => {
    const getUsage = vi.fn(async (): Promise<UsageResult> => {
      if (reject) throw new Error("offline");
      return { ok: false, reason: "http" };
    });
    const initial = setCooldown(setCooldown(accounts(), "main", now + 1000, "rate_limit"), "work", now + 2000, "rate_limit");
    const h = harness(initial, {}, undefined, getUsage);
    await h.runtime.onSessionStart();
    await vi.waitFor(() => expect(h.setStatus).toHaveBeenLastCalledWith("claude: main (probe) · limits unavailable", "warning"));
  });
  it("does not await usage on requests and discards stale results after switching away and back or shutdown", async () => {
    const finishes: ((result: UsageResult) => void)[] = [];
    const getUsage = vi.fn(() => new Promise<UsageResult>(resolve => { finishes.push(resolve); }));
    const h = harness(accounts(), {}, undefined, getUsage);
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: main");
    h.replace(setPreferred(h.state, "work"));
    await h.runtime.refresh();
    h.replace(setPreferred(h.state, "main"));
    await h.runtime.beforeRequest();
    finishes[0]({ ok: false, reason: "http" });
    finishes[1]({ ok: false, reason: "http" });
    await Promise.resolve();
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: main");
    h.runtime.onSessionShutdown();
    finishes[2]({ ok: false, reason: "http" });
    await Promise.resolve();
    expect(h.setStatus).toHaveBeenLastCalledWith(undefined);
  });
  it("invalidates usage when the same name is re-added with a different directory", async () => {
    const finishes: ((result: UsageResult) => void)[] = [];
    const getUsage = vi.fn(() => new Promise<UsageResult>(resolve => { finishes.push(resolve); }));
    const h = harness(accounts(), {}, undefined, getUsage);
    await h.runtime.onSessionStart();
    h.replace(addAccount(empty(), "main", "/replacement"));
    await h.runtime.beforeRequest();
    expect(getUsage).toHaveBeenLastCalledWith("main", "/replacement");
    finishes[0]({ ok: false, reason: "http" }); await Promise.resolve();
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: main");
    finishes[1]({ ok: true, fiveHour: null, weekly: null }); await Promise.resolve();
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: main · 5h -- · wk --", "dim");
  });
  it("keeps the latest refresh result when requests finish out of order", async () => {
    const finishes: ((result: UsageResult) => void)[] = [];
    const getUsage = vi.fn(() => new Promise<UsageResult>(resolve => { finishes.push(resolve); }));
    const h = harness(accounts(), {}, undefined, getUsage);
    await h.runtime.onSessionStart();
    h.runtime.refreshUsage();
    finishes[1]({ ok: true, fiveHour: null, weekly: null }); await Promise.resolve();
    finishes[0]({ ok: false, reason: "http" }); await Promise.resolve();
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: main · 5h -- · wk --", "dim");
  });
  it("refreshes after automatic failover and ignores pending usage when all accounts exhaust", async () => {
    const finishes: ((result: UsageResult) => void)[] = [];
    const getUsage = vi.fn(() => new Promise<UsageResult>(resolve => { finishes.push(resolve); }));
    const h = harness(accounts(), {}, undefined, getUsage);
    await h.runtime.onSessionStart(); await h.runtime.beforeRequest();
    await h.runtime.onAssistantMessageEnd(error());
    expect(getUsage).toHaveBeenLastCalledWith("work", "/work");
    finishes[0]({ ok: false, reason: "http" }); await Promise.resolve();
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: work");
    await h.runtime.beforeRequest(); await h.runtime.onAssistantMessageEnd(error());
    finishes[1]({ ok: false, reason: "http" }); await Promise.resolve();
    expect(h.setStatus).toHaveBeenLastCalledWith(`claude: no accounts · back ${time(now + 3_600_000)}`);
  });
  it("warns once with every offending account and shell-safe fix commands", async () => {
    const initial = addAccount(addAccount(addAccount(empty(), "main", null), "work", "/work dir"), "other", "/other' dir");
    const check = vi.fn(async (): Promise<ProjectsIssue[]> => [
      { name: "work", configDir: "/work dir", reason: "not-shared" },
      { name: "other", configDir: "/other' dir", reason: "missing" },
    ]);
    const h = harness(initial, { HOME: "/home/test user" }, check);
    await h.runtime.onSessionStart();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(check).toHaveBeenCalledWith(initial.accounts, { homeDir: "/home/test user" });
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('Claude account "work" does not share session history with "main"; switching accounts will fail to resume. Fix: mv \'/work dir/projects\' \'/work dir/projects.bak\' && ln -s \'/home/test user/.claude/projects\' \'/work dir/projects\''), "warning");
    expect(h.notify.mock.calls[0][0]).toContain('Claude account "other"');
    // Missing directories need no move; shell apostrophes must remain literal.
    expect(h.notify.mock.calls[0][0]).toContain(`Fix: ln -s '/home/test user/.claude/projects' '/other'"'"' dir/projects'`);
  });
  it("does not warn when projects are shared", async () => {
    const h = harness();
    await h.runtime.onSessionStart();
    await Promise.resolve();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("runs projects checks in the background and ignores results after shutdown", async () => {
    let finish!: (issues: ProjectsIssue[]) => void;
    const check = vi.fn(() => new Promise<ProjectsIssue[]>(resolve => { finish = resolve; }));
    const h = harness(accounts(), {}, check);
    await h.runtime.onSessionStart();
    expect(check).toHaveBeenCalledTimes(1);
    h.runtime.onSessionShutdown();
    finish([{ name: "work", configDir: "/work", reason: "not-shared" }]);
    await Promise.resolve();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("ignores stale projects results after a new session starts", async () => {
    let finish!: (issues: ProjectsIssue[]) => void;
    const check = vi.fn(async (): Promise<ProjectsIssue[]> => []);
    check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const h = harness(accounts(), {}, check);
    await h.runtime.onSessionStart();
    await h.runtime.onSessionStart();
    finish([{ name: "work", configDir: "/work", reason: "not-shared" }]);
    await Promise.resolve();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("skips projects checks in unmanaged mode or without accounts", async () => {
    const check = vi.fn(async (): Promise<ProjectsIssue[]> => []);
    await harness(accounts(), { CLAUDE_CONFIG_DIR: "/foreign" }, check).runtime.onSessionStart();
    await harness(empty(), {}, check).runtime.onSessionStart();
    expect(check).not.toHaveBeenCalled();
  });
  it("does not throw or notify when the background projects check fails", async () => {
    const check = vi.fn(async (): Promise<ProjectsIssue[]> => { throw new Error("check unavailable"); });
    const h = harness(accounts(), {}, check);
    await expect(h.runtime.onSessionStart()).resolves.toBeUndefined();
    await Promise.resolve();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("uses the first account in warning commands when there is no default", async () => {
    const initial = addAccount(addAccount(empty(), "first", "/first"), "work", "/work");
    const check = vi.fn(async (): Promise<ProjectsIssue[]> => [{ name: "work", configDir: "/work", reason: "not-shared" }]);
    const h = harness(initial, {}, check);
    await h.runtime.onSessionStart();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(h.notify).toHaveBeenCalledWith('Claude account "work" does not share session history with "first"; switching accounts will fail to resume. Fix: mv /work/projects /work/projects.bak && ln -s /first/projects /work/projects', "warning");
  });
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
    expect(h.state.state.main.cooldownUntil).toBe(until + 3_600_000);
  });
  it.each([
    ["Failed to authenticate", "Failed to authenticate"],
    ["API Error: 400 billing_error: credit balance too low", "billing_error"],
  ])("marks account problem %j for attention and switches with a retryable error", async (errorMessage, reason) => {
    const h = harness();
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    const message = error(errorMessage);
    const replacement = await h.runtime.onAssistantMessageEnd(message);
    expect(h.state.state.main.needsAttention).toBe(reason);
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    expect(h.setStatus).toHaveBeenLastCalledWith("claude: work");
    expect(h.notify).toHaveBeenCalledWith(`Claude account "main" needs attention: ${reason} — switched to "work"`, "error");
    expect(replacement).toEqual({ ...message, errorMessage: 'Claude account "main" needs attention — switched to "work", retrying (service unavailable)' });
    expect(replacement!.errorMessage).not.toMatch(/billing|quota exceeded|auth/i);
    expect(message.errorMessage).toBe(errorMessage);
  });
  it("flags every account that fails with an account problem and stops when none is usable", async () => {
    const h = harness();
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    await h.runtime.onAssistantMessageEnd(error("Failed to authenticate"));
    await h.runtime.beforeRequest();
    expect(await h.runtime.onAssistantMessageEnd(error("Failed to authenticate"))).toBeUndefined();
    expect(h.state.state.main.needsAttention).toBe("Failed to authenticate");
    expect(h.state.state.work.needsAttention).toBe("Failed to authenticate");
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    expect(h.notify).toHaveBeenLastCalledWith('Claude account "work" needs attention: Failed to authenticate — rotation stopped for this account', "error");
  });
  it("does not switch to a cooling account after an account problem", async () => {
    const h = harness(setCooldown(accounts(), "work", now + 3_600_000, "rate_limit"));
    await h.runtime.onSessionStart();
    await h.runtime.beforeRequest();
    expect(await h.runtime.onAssistantMessageEnd(error("Failed to authenticate"))).toBeUndefined();
    expect(h.state.state.main.needsAttention).toBe("Failed to authenticate");
    expect(h.state.state.work.cooldownUntil).toBe(now + 3_600_000);
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
  describe("resume after failover", () => {
    // pi-claude-bridge answers Pi's retry of a turn interrupted at a tool boundary
    // with an empty stop instead of a new query, so the turn would end silently.
    const emptyStop = () => ({ role: "assistant", provider: "claude-bridge", stopReason: "stop", content: [] });
    it.each([
      ["rate limit", "Claude rate limit (five_hour)"],
      ["account problem", "Failed to authenticate"],
    ])("resumes once when the retry after a %s switch ends empty", async (_kind, errorMessage) => {
      const h = harness();
      await h.runtime.onSessionStart();
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(error(errorMessage));
      expect(h.resume).not.toHaveBeenCalled();
      await h.runtime.beforeRequest();
      const message = emptyStop();
      expect(await h.runtime.onAssistantMessageEnd(message)).toBeUndefined();
      expect(message).toEqual(emptyStop());
      expect(h.resume).toHaveBeenCalledTimes(1);
      expect(h.notify).toHaveBeenLastCalledWith('Claude account switched to "work" — resuming the interrupted turn', "info");
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(emptyStop());
      expect(h.resume).toHaveBeenCalledTimes(1);
    });
    it("does not resume an empty stop without a preceding switch", async () => {
      const h = harness();
      await h.runtime.onSessionStart();
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(emptyStop());
      expect(h.resume).not.toHaveBeenCalled();
    });
    it("does not resume when the retry answers, nor on a later empty stop", async () => {
      const h = harness();
      await h.runtime.onSessionStart();
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(error());
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd({ ...emptyStop(), content: [{ type: "text", text: "done" }] });
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(emptyStop());
      expect(h.resume).not.toHaveBeenCalled();
    });
    it("does not resume when every account is exhausted", async () => {
      const h = harness(setCooldown(accounts(), "work", now + 7_200_000, "rate_limit"));
      await h.runtime.onSessionStart();
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(error());
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(emptyStop());
      expect(h.resume).not.toHaveBeenCalled();
    });
    it("does not resume an empty stop from another provider", async () => {
      const h = harness();
      await h.runtime.onSessionStart();
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(error());
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd({ ...emptyStop(), provider: "anthropic" });
      expect(h.resume).not.toHaveBeenCalled();
    });
    it("forgets a pending resume on session start", async () => {
      const h = harness();
      await h.runtime.onSessionStart();
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(error());
      await h.runtime.onSessionStart();
      await h.runtime.beforeRequest();
      await h.runtime.onAssistantMessageEnd(emptyStop());
      expect(h.resume).not.toHaveBeenCalled();
    });
  });
});
