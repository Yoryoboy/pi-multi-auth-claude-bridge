import { describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySharedSetup, describeSetupPlan, planSharedSetup } from "../src/shared-setup.js";

const stamp = new Date(2026, 9, 12, 15, 4, 5).getTime();

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), "shared-setup-"));
  const reference = join(root, "ref");
  const target = join(root, "work");
  await mkdir(join(reference, "projects", "p1"), { recursive: true });
  await writeFile(join(reference, "settings.json"), '{"ref":true}');
  await writeFile(join(reference, "projects", "p1", "a.jsonl"), "ref-a");
  await mkdir(target, { recursive: true });
  return { root, reference, target };
}
const isLinkTo = async (path: string, to: string) =>
  (await lstat(path)).isSymbolicLink() && await realpath(path) === await realpath(to);

describe("planSharedSetup / applySharedSetup", () => {
  it("links missing settings.json and projects to the reference", async () => {
    const d = await dirs();
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    expect(plan.steps.map(step => [step.item, step.kind])).toEqual([["settings.json", "link"], ["projects", "link"]]);
    const outcomes = await applySharedSetup(plan);
    expect(outcomes.every(outcome => outcome.ok)).toBe(true);
    expect(await isLinkTo(join(d.target, "settings.json"), join(d.reference, "settings.json"))).toBe(true);
    expect(await isLinkTo(join(d.target, "projects"), join(d.reference, "projects"))).toBe(true);
    expect(await readlink(join(d.target, "projects"))).toBe(join(d.reference, "projects"));
  });

  it("reports already shared links and changes nothing", async () => {
    const d = await dirs();
    await symlink(join(d.reference, "settings.json"), join(d.target, "settings.json"));
    await symlink(join(d.reference, "projects"), join(d.target, "projects"));
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    expect(plan.steps.map(step => step.kind)).toEqual(["shared", "shared"]);
    expect(describeSetupPlan(plan).actionable).toBe(false);
    expect(await applySharedSetup(plan)).toEqual([
      { item: "settings.json", ok: true, shared: true, message: "already shared" },
      { item: "projects", ok: true, shared: true, message: "already shared" },
    ]);
  });

  it("leaves symlinks that point elsewhere unchanged", async () => {
    const d = await dirs();
    const other = join(d.root, "other");
    await mkdir(other);
    await symlink(other, join(d.target, "projects"));
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    expect(plan.steps[1]).toEqual({ item: "projects", kind: "skip", reason: `symlink to another location; left unchanged` });
    const outcomes = await applySharedSetup(plan);
    expect(outcomes[1]).toEqual({ item: "projects", ok: true, shared: false, message: "symlink to another location; left unchanged" });
    expect(await readlink(join(d.target, "projects"))).toBe(other);
  });

  it("backs up a real projects dir, merges without overwriting, and links", async () => {
    const d = await dirs();
    await mkdir(join(d.target, "projects", "p1"), { recursive: true });
    await mkdir(join(d.target, "projects", "p2"), { recursive: true });
    await writeFile(join(d.target, "projects", "p1", "a.jsonl"), "work-a");
    await writeFile(join(d.target, "projects", "p1", "b.jsonl"), "work-b");
    await writeFile(join(d.target, "projects", "p2", "c.jsonl"), "work-c");
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    const backup = join(d.target, "projects.bak-20261012-150405", "projects");
    expect(plan.steps[1]).toMatchObject({ item: "projects", kind: "replace", backup, merge: true });
    const outcomes = await applySharedSetup(plan);
    expect(outcomes[1]).toEqual({
      item: "projects", ok: true, shared: true,
      message: `merged into ${join(d.reference, "projects")} (1 conflict kept only in the backup); backup at ${backup}`,
    });
    expect(await readFile(join(d.reference, "projects", "p1", "a.jsonl"), "utf8")).toBe("ref-a");
    expect(await readFile(join(d.reference, "projects", "p1", "b.jsonl"), "utf8")).toBe("work-b");
    expect(await readFile(join(d.reference, "projects", "p2", "c.jsonl"), "utf8")).toBe("work-c");
    expect(await readFile(join(backup, "p1", "a.jsonl"), "utf8")).toBe("work-a");
    expect(await isLinkTo(join(d.target, "projects"), join(d.reference, "projects"))).toBe(true);
  });

  it("backs up a real settings.json without merging", async () => {
    const d = await dirs();
    await writeFile(join(d.target, "settings.json"), '{"work":true}');
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    const backup = join(d.target, "settings.json.bak-20261012-150405", "settings.json");
    expect(plan.steps[0]).toMatchObject({ item: "settings.json", kind: "replace", backup, merge: false });
    const outcomes = await applySharedSetup(plan);
    expect(outcomes[0]).toEqual({ item: "settings.json", ok: true, shared: true, message: `linked; previous file at ${backup}` });
    expect(await readFile(backup, "utf8")).toBe('{"work":true}');
    expect(await readFile(join(d.reference, "settings.json"), "utf8")).toBe('{"ref":true}');
    expect(await isLinkTo(join(d.target, "settings.json"), join(d.reference, "settings.json"))).toBe(true);
  });

  it("picks a unique backup name when one already exists", async () => {
    const d = await dirs();
    await writeFile(join(d.target, "settings.json"), "x");
    await writeFile(join(d.target, "settings.json.bak-20261012-150405"), "old");
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    expect(plan.steps[0]).toMatchObject({ backup: join(d.target, "settings.json.bak-20261012-150405-2", "settings.json") });
    await applySharedSetup(plan);
    expect(await readFile(join(d.target, "settings.json.bak-20261012-150405"), "utf8")).toBe("old");
  });

  it("refuses to overwrite a backup that appeared after planning", async () => {
    const d = await dirs();
    await writeFile(join(d.target, "settings.json"), "x");
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    await mkdir(join(d.target, "settings.json.bak-20261012-150405"));
    await writeFile(join(d.target, "settings.json.bak-20261012-150405", "settings.json"), "late");
    const outcomes = await applySharedSetup(plan);
    expect(outcomes[0]).toMatchObject({ item: "settings.json", ok: false, shared: false });
    expect(await readFile(join(d.target, "settings.json"), "utf8")).toBe("x");
    expect(await readFile(join(d.target, "settings.json.bak-20261012-150405", "settings.json"), "utf8")).toBe("late");
  });

  it("creates a missing reference projects dir before linking", async () => {
    const d = await dirs();
    const reference = join(d.root, "fresh-ref");
    await mkdir(reference);
    const plan = await planSharedSetup(d.target, reference, { now: () => stamp });
    expect(plan.steps).toEqual([
      { item: "settings.json", kind: "skip", reason: "the reference account has no settings.json" },
      { item: "projects", kind: "link", target: join(d.target, "projects"), source: join(reference, "projects"), createSource: true },
    ]);
    await applySharedSetup(plan);
    expect((await lstat(join(reference, "projects"))).mode & 0o777).toBe(0o700);
    expect(await isLinkTo(join(d.target, "projects"), join(reference, "projects"))).toBe(true);
  });

  it("restores the original projects dir when linking fails", async () => {
    const d = await dirs();
    await mkdir(join(d.target, "projects"));
    await writeFile(join(d.target, "projects", "keep.jsonl"), "keep");
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    const failingSymlink = vi.fn(async () => { throw new Error("EPERM: operation not permitted"); });
    const outcomes = await applySharedSetup(plan, { symlink: failingSymlink });
    expect(outcomes[1]).toEqual({ item: "projects", ok: false, shared: false, message: "EPERM: operation not permitted; original restored" });
    expect((await lstat(join(d.target, "projects"))).isDirectory()).toBe(true);
    expect(await readFile(join(d.target, "projects", "keep.jsonl"), "utf8")).toBe("keep");
    await expect(lstat(join(d.target, "projects.bak-20261012-150405", "projects"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes files it merged into the reference when linking fails", async () => {
    const d = await dirs();
    await mkdir(join(d.target, "projects", "p9"), { recursive: true });
    await writeFile(join(d.target, "projects", "p9", "new.jsonl"), "new");
    await mkdir(join(d.target, "projects", "p1"));
    await writeFile(join(d.target, "projects", "p1", "a.jsonl"), "work-a");
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    await applySharedSetup(plan, { symlink: async () => { throw new Error("EPERM"); } });
    await expect(lstat(join(d.reference, "projects", "p9"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(d.reference, "projects", "p1", "a.jsonl"), "utf8")).toBe("ref-a");
    expect(await readFile(join(d.target, "projects", "p9", "new.jsonl"), "utf8")).toBe("new");
  });

  it("keeps reference files that changed after the merge when undoing", async () => {
    const d = await dirs();
    await mkdir(join(d.target, "projects", "p9"), { recursive: true });
    await writeFile(join(d.target, "projects", "p9", "new.jsonl"), "new");
    await writeFile(join(d.target, "projects", "p9", "other.jsonl"), "copied");
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    // Another writer replaces one merged file before the undo runs.
    await applySharedSetup(plan, { symlink: async () => {
      await writeFile(join(d.reference, "projects", "p9", "other.jsonl"), "OTHER_WRITER");
      throw new Error("EPERM");
    } });
    expect(await readFile(join(d.reference, "projects", "p9", "other.jsonl"), "utf8")).toBe("OTHER_WRITER");
    await expect(lstat(join(d.reference, "projects", "p9", "new.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(d.target, "projects", "p9", "other.jsonl"), "utf8")).toBe("copied");
  });

  it.each(["projects", "settings.json"] as const)("treats a reference %s that already points into the account as shared", async item => {
    const d = await dirs();
    const real = join(d.target, item);
    if (item === "projects") { await mkdir(join(real, "p5"), { recursive: true }); await writeFile(join(real, "p5", "x.jsonl"), "x"); }
    else await writeFile(real, '{"work":true}');
    const { rm } = await import("node:fs/promises");
    await rm(join(d.reference, item), { recursive: true });
    await symlink(real, join(d.reference, item));
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    expect(plan.steps.find(step => step.item === item)).toEqual({ item, kind: "shared" });
    await applySharedSetup(plan);
    expect((await lstat(real)).isSymbolicLink()).toBe(false);
    expect(await realpath(join(d.reference, item))).toBe(await realpath(real));
  });

  it("never touches credentials, .claude.json, sessions or plugins", async () => {
    const d = await dirs();
    for (const name of [".credentials.json", ".claude.json"]) {
      await writeFile(join(d.target, name), `target-${name}`);
      await writeFile(join(d.reference, name), `ref-${name}`);
    }
    for (const name of ["sessions", "plugins"]) await mkdir(join(d.target, name));
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    expect(plan.steps.map(step => step.item)).toEqual(["settings.json", "projects"]);
    await applySharedSetup(plan);
    for (const name of [".credentials.json", ".claude.json"]) {
      expect((await lstat(join(d.target, name))).isFile()).toBe(true);
      expect(await readFile(join(d.target, name), "utf8")).toBe(`target-${name}`);
    }
    for (const name of ["sessions", "plugins"]) expect((await lstat(join(d.target, name))).isDirectory()).toBe(true);
  });

  it("plans nothing when the account directory is the reference", async () => {
    const d = await dirs();
    const plan = await planSharedSetup(d.reference, d.reference, { now: () => stamp });
    expect(plan.steps).toEqual([]);
  });

  it("describes every actionable step for the confirmation dialog", async () => {
    const d = await dirs();
    await mkdir(join(d.target, "projects"));
    const plan = await planSharedSetup(d.target, d.reference, { now: () => stamp });
    const { actionable, text } = describeSetupPlan(plan);
    expect(actionable).toBe(true);
    expect(text).toBe([
      `• settings.json: link ${join(d.target, "settings.json")} → ${join(d.reference, "settings.json")}`,
      `• projects/: move ${join(d.target, "projects")} to ${join(d.target, "projects.bak-20261012-150405", "projects")}, copy its files into ${join(d.reference, "projects")} without overwriting, then link`,
      "Stop Claude Code sessions that use this account first.",
      ".credentials.json, .claude.json, sessions/ and plugins/ are never touched.",
    ].join("\n"));
  });
});
