import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import type { UsageResult } from "../src/usage.js";
import type { AuthStatus } from "../src/auth-status.js";
import { addAccount, removeAccount, setIdentity, type AccountEntry, type StateFile, type StoreMutation } from "../src/accounts/store.js";

function harness(hasUI = true, checkAccount: (account: AccountEntry, signal: AbortSignal) => Promise<AuthStatus> = vi.fn(async () => ({ kind: "unavailable" as const, reason: "not installed" })), getUsage = vi.fn((_name: string, _dir: string | null) => new Promise<UsageResult>(() => {}))) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const pi = { on: vi.fn((event: string, handler: any) => { handlers[event] = handler; }), registerCommand: vi.fn(), registerProvider: vi.fn() };
  const ctx = { hasUI, ui: { notify: vi.fn(), setStatus: vi.fn() } };
  let state: StateFile = addAccount({ version: 1, accounts: [], preferred: null, state: {} }, "work", "/work");
  const store = { load: vi.fn(async () => state), mutate: vi.fn(async (fn: StoreMutation) => { state = await fn(state); return state; }) };
  const env: NodeJS.ProcessEnv = {};
  extension(pi as any, { createStore: () => store, env, now: () => 1_000, checkAccount, getUsage });
  return { pi, handlers, ctx, env, store, checkAccount, getUsage, get state() { return state; }, replace(next: StateFile) { state = next; } };
}

describe("Pi extension wiring", () => {
  it("registers the plural TUI command", () => {
    const h = harness();
    expect(h.pi.registerCommand).toHaveBeenCalledWith("claude-accounts", expect.objectContaining({ handler: expect.any(Function) }));
  });
  it.each([{ hasUI: true, mode: "rpc" }, { hasUI: false, mode: "tui" }, { hasUI: false, mode: "print" }])(
    "guards the plural menu outside dialog-capable TUI ($hasUI/$mode)", async ({ hasUI, mode }) => {
      const h = harness(hasUI);
      const select = vi.fn();
      const ctx = { ...h.ctx, mode, ui: { ...h.ctx.ui, select } };
      const command = h.pi.registerCommand.mock.calls.find(([name]) => name === "claude-accounts")?.[1];
      expect(command).toBeDefined();
      await command!.handler("", ctx);
      expect(select).not.toHaveBeenCalled();
      expect(h.store.load).not.toHaveBeenCalled();
      expect(h.ctx.ui.notify).toHaveBeenCalledWith("/claude-accounts requires the interactive TUI.", "error");
    },
  );
  it("dispatches menu actions through the typed handler and refreshes usage after closing", async () => {
    const getUsage = vi.fn(async (): Promise<UsageResult> => ({ ok: false, reason: "unavailable" }));
    const h = harness(true, undefined, getUsage);
    await h.handlers.session_start({}, h.ctx);
    const select = vi.fn()
      .mockImplementationOnce(async (_title: string, rows: string[]) => rows[0])
      .mockResolvedValueOnce("Use")
      .mockResolvedValueOnce("Close");
    const command = h.pi.registerCommand.mock.calls.find(([name]) => name === "claude-accounts")?.[1];
    expect(command).toBeDefined();
    await command!.handler("", { ...h.ctx, mode: "tui", ui: { ...h.ctx.ui, select } });
    expect(h.state.preferred).toBe("work");
    expect(h.ctx.ui.notify).toHaveBeenCalledWith("Claude account use: work applied; automatic failover remains enabled.", "info");
    expect(getUsage.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("claude-accounts", "claude: work");
  });
  it("refreshes usage on start, turn end and commands without blocking context; clears on shutdown", async () => {
    const h = harness(true, undefined, vi.fn(async (): Promise<UsageResult> => ({ ok: false, reason: "unavailable" })));
    await h.handlers.session_start({}, h.ctx);
    expect(h.getUsage).toHaveBeenCalledTimes(1);
    await h.handlers.context({}, h.ctx);
    expect(h.getUsage).toHaveBeenCalledTimes(1);
    await h.handlers.turn_end({}, h.ctx);
    expect(h.getUsage).toHaveBeenCalledTimes(2);
    const select = vi.fn().mockResolvedValueOnce("Close");
    await h.pi.registerCommand.mock.calls[0][1].handler("", { ...h.ctx, mode: "tui", ui: { ...h.ctx.ui, select } });
    expect(h.getUsage.mock.calls.length).toBeGreaterThan(2);
    await h.handlers.session_shutdown({}, h.ctx);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("claude-accounts", undefined);
  });
  it.each([true, false])("uses theme coloring when available (%s)", async themed => {
    const getUsage = vi.fn(async (): Promise<UsageResult> => ({ ok: true,
      fiveHour: { usedPercent: 91, resetsAt: null }, weekly: null,
    }));
    const h = harness(true, undefined, getUsage);
    const fg = vi.fn((level: string, text: string) => `${level}:${text}`);
    if (themed) Object.assign(h.ctx.ui, { theme: { fg } });
    await h.handlers.session_start({}, h.ctx);
    await vi.waitFor(() => expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("claude-accounts",
      `${themed ? "error:" : ""}claude: work · 5h 91% · wk --`));
    if (themed) expect(fg).toHaveBeenCalledWith("error", "claude: work · 5h 91% · wk --");
  });
  it("registers lifecycle hooks and command without starting auth checks", () => {
    const h = harness();
    expect(Object.keys(h.handlers)).toEqual(["session_start", "context", "message_end", "turn_end", "session_shutdown"]);
    expect(h.pi.registerCommand.mock.calls.map(([name]) => name)).toEqual(["claude-accounts"]);
    expect(h.checkAccount).not.toHaveBeenCalled();
    expect(h.pi.registerProvider).not.toHaveBeenCalled();
    expect(h.store.load).not.toHaveBeenCalled();
    expect(h.env).toEqual({});
  });
  it("applies env before every request and wraps replacement in the Pi return contract", async () => {
    const h = harness();
    await h.handlers.session_start({}, h.ctx);
    await h.handlers.context({ messages: [] }, h.ctx);
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("claude-accounts", "claude: work");
    const message = { role: "assistant", provider: "claude-bridge", stopReason: "error", errorMessage: "Claude rate limit", content: [] };
    const result = await h.handlers.message_end({ message }, h.ctx);
    expect(result).toEqual({ message: { ...message, errorMessage: expect.stringMatching(/^Claude quota exceeded on all accounts — work resets \d{2}:\d{2}$/) } });
    await h.handlers.context({ messages: [] }, h.ctx);
    expect(h.store.load).toHaveBeenCalledTimes(3);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("claude-accounts", "claude: work (probe)");
  });
  it("rotates without touching UI in headless mode", async () => {
    const h = harness(false);
    await h.handlers.session_start({}, h.ctx);
    await h.handlers.context({}, h.ctx);
    await h.handlers.message_end({ message: { role: "assistant", provider: "claude-bridge", stopReason: "error", errorMessage: "Claude rate limit" } }, h.ctx);
    expect(h.env.CLAUDE_CONFIG_DIR).toBe("/work");
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
  });
  it("starts nonblocking checks and aborts on shutdown without late mutations", async () => {
    let resolve!: (result: any) => void;
    const check = vi.fn((_account: any, _signal: AbortSignal) => new Promise<any>(r => { resolve = r; }));
    const h = harness(true, check);
    await h.handlers.session_start({}, h.ctx);
    expect(check).toHaveBeenCalledOnce();
    await h.handlers.session_shutdown({}, h.ctx);
    expect(check.mock.calls[0][1].aborted).toBe(true);
    resolve({ kind: "logged-out" }); await new Promise(r => setTimeout(r, 0));
    expect(h.store.mutate).not.toHaveBeenCalled();
  });
  it("caches local identity and marks mismatches without overwriting identity", async () => {
    const check = vi.fn(async () => ({ kind: "ok" as const, identity: "alice" }));
    const h = harness(true, check); await h.handlers.session_start({}, h.ctx);
    await vi.waitFor(() => expect(h.state.state.work.identity).toBe("alice"));
    await h.handlers.session_shutdown({}, h.ctx);
    h.replace(setIdentity(h.state, "work", "bob"));
    await h.handlers.session_start({}, h.ctx);
    await vi.waitFor(() => expect(h.state.state.work.needsAttention).toBe("identity changed: bob -> alice"));
    expect(h.state.state.work.identity).toBe("bob");
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("identity changed: bob -> alice"), "warning");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("claude-accounts", "claude: no usable accounts");
  });
  it("ignores validation results for removed accounts", async () => {
    let resolve!: (result: AuthStatus) => void;
    const h = harness(true, vi.fn(() => new Promise<AuthStatus>(r => { resolve = r; })));
    await h.handlers.session_start({}, h.ctx);
    h.replace(removeAccount(h.state, "work"));
    resolve({ kind: "logged-out" });
    await new Promise(r => setTimeout(r, 0));
    expect(h.state.accounts).toEqual([]); expect(h.state.state).toEqual({});
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
  });
  it("marks logged out accounts unusable", async () => {
    const h = harness(true, vi.fn(async () => ({ kind: "logged-out" as const })));
    await h.handlers.session_start({}, h.ctx);
    await vi.waitFor(() => expect(h.state.state.work.needsAttention).toBe("logged out"));
  });
  it("notifies unavailable once total with no state changes", async () => {
    const h = harness(); h.replace(addAccount(h.state, "main", null));
    await h.handlers.session_start({}, h.ctx);
    await vi.waitFor(() => expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1));
    expect(h.store.mutate).not.toHaveBeenCalled();
  });
  it("skips validation in unmanaged or empty registries", async () => {
    const h = harness(); h.env.CLAUDE_CONFIG_DIR = "/foreign";
    await h.handlers.session_start({}, h.ctx); expect(h.checkAccount).not.toHaveBeenCalled();
    const e = harness(); e.replace({ version: 1, accounts: [], preferred: null, state: {} });
    await e.handlers.session_start({}, e.ctx); expect(e.checkAccount).not.toHaveBeenCalled();
  });
  it("ignores user messages without returning a replacement", async () => {
    const h = harness();
    await h.handlers.session_start({}, h.ctx);
    await h.handlers.context({}, h.ctx);
    expect(await h.handlers.message_end({ message: { role: "user", content: [] } }, h.ctx)).toBeUndefined();
    expect(h.store.mutate).not.toHaveBeenCalled();
  });
});
