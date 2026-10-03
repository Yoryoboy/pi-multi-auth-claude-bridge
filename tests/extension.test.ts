import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

describe("Pi extension entry", () => {
  it("loads without registering anything or touching CLAUDE_CONFIG_DIR", () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    const pi = { on: vi.fn(), registerCommand: vi.fn(), registerProvider: vi.fn() };
    extension(pi as any);
    expect(pi.on).not.toHaveBeenCalled();
    expect(pi.registerCommand).not.toHaveBeenCalled();
    expect(pi.registerProvider).not.toHaveBeenCalled();
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
  });
});
