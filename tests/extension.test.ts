import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { addAccount, type StateFile, type StoreMutation } from "../src/accounts/store.js";

function harness(hasUI = true) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const pi = { on: vi.fn((event: string, handler: any) => { handlers[event] = handler; }), registerCommand: vi.fn(), registerProvider: vi.fn() };
  const ctx = { hasUI, ui: { notify: vi.fn(), setStatus: vi.fn() } };
  let state: StateFile = addAccount({ version: 1, accounts: [], preferred: null, state: {} }, "work", "/work");
  const store = { load: vi.fn(async () => state), mutate: vi.fn(async (fn: StoreMutation) => { state = await fn(state); return state; }) };
  const env: NodeJS.ProcessEnv = {};
  extension(pi as any, { createStore: () => store, env, now: () => 1_000 });
  return { pi, handlers, ctx, env, store };
}

describe("Pi extension wiring", () => {
  it("registers session_start, per-request context, and message_end only", () => {
    const h = harness();
    expect(Object.keys(h.handlers)).toEqual(["session_start", "context", "message_end"]);
    expect(h.pi.registerCommand).not.toHaveBeenCalled();
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
  it("ignores user messages without returning a replacement", async () => {
    const h = harness();
    await h.handlers.session_start({}, h.ctx);
    await h.handlers.context({}, h.ctx);
    expect(await h.handlers.message_end({ message: { role: "user", content: [] } }, h.ctx)).toBeUndefined();
    expect(h.store.mutate).not.toHaveBeenCalled();
  });
});
