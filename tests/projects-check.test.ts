import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSharedProjects } from "../src/projects-check.js";

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "claude-projects-check-"));
  const reference = join(homeDir, ".claude", "projects");
  const configDir = join(homeDir, "work");
  await mkdir(configDir);
  return { homeDir, reference, configDir, accounts: [{ name: "main", configDir: null }, { name: "work", configDir }] };
}

describe("shared projects check", () => {
  it("accepts real symlinks to the default projects directory", async () => {
    const f = await fixture();
    await mkdir(f.reference, { recursive: true });
    await symlink(f.reference, join(f.configDir, "projects"));
    expect(await checkSharedProjects(f.accounts, { homeDir: f.homeDir })).toEqual([]);
  });
  it("reports separate directories", async () => {
    const f = await fixture();
    await mkdir(f.reference, { recursive: true });
    await mkdir(join(f.configDir, "projects"));
    expect(await checkSharedProjects(f.accounts, { homeDir: f.homeDir })).toEqual([
      { name: "work", configDir: f.configDir, reason: "not-shared" },
    ]);
  });
  it("reports a missing account projects directory", async () => {
    const f = await fixture();
    await mkdir(f.reference, { recursive: true });
    expect(await checkSharedProjects(f.accounts, { homeDir: f.homeDir })).toEqual([
      { name: "work", configDir: f.configDir, reason: "missing" },
    ]);
  });
  it("does not compare when the reference is missing", async () => {
    const f = await fixture();
    await mkdir(join(f.configDir, "projects"));
    expect(await checkSharedProjects(f.accounts, { homeDir: f.homeDir })).toEqual([]);
  });
  it("uses the first account as reference without a default account", async () => {
    const f = await fixture();
    await mkdir(join(f.configDir, "projects"));
    const second = join(f.homeDir, "second");
    await mkdir(second);
    await symlink(join(f.configDir, "projects"), join(second, "projects"));
    expect(await checkSharedProjects([{ name: "work", configDir: f.configDir }, { name: "second", configDir: second }], { homeDir: f.homeDir })).toEqual([]);
    expect(await checkSharedProjects([{ name: "work", configDir: f.configDir }, { name: "other", configDir: join(f.homeDir, "other") }], { homeDir: f.homeDir })).toEqual([
      { name: "other", configDir: join(f.homeDir, "other"), reason: "missing" },
    ]);
  });
  it("handles empty and default-only registries", async () => {
    const f = await fixture();
    await mkdir(f.reference, { recursive: true });
    expect(await checkSharedProjects([], { homeDir: f.homeDir })).toEqual([]);
    expect(await checkSharedProjects([f.accounts[0]], { homeDir: f.homeDir })).toEqual([]);
  });
  it("prefers a default reference even if registered later", async () => {
    const f = await fixture();
    await mkdir(f.reference, { recursive: true });
    expect(await checkSharedProjects([...f.accounts].reverse(), { homeDir: f.homeDir })).toEqual([
      { name: "work", configDir: f.configDir, reason: "missing" },
    ]);
  });
  it("skips non-ENOENT errors without throwing", async () => {
    const f = await fixture();
    await mkdir(f.reference, { recursive: true });
    const denied = async (path: string) => {
      if (path === f.reference) return realpath(path);
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(await checkSharedProjects(f.accounts, { homeDir: f.homeDir, realpath: denied })).toEqual([]);
    expect(await checkSharedProjects(f.accounts, { homeDir: f.homeDir, realpath: async () => { throw new Error("denied"); } })).toEqual([]);
  });
});
