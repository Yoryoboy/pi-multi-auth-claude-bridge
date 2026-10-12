import { cp, lstat, mkdir, realpath, rename, stat as followStat, symlink as nodeSymlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Shares `settings.json` and `projects/` of a new account with the reference account.
 * Only these two entries are ever touched; credentials, `.claude.json`, `sessions/`
 * and `plugins/` stay per-account. Existing data is moved to a unique backup, never deleted.
 */
export type SharedItem = "settings.json" | "projects";
export type SetupStep =
  | { item: SharedItem; kind: "shared" }
  | { item: SharedItem; kind: "skip"; reason: string }
  | { item: SharedItem; kind: "link"; target: string; source: string; createSource: boolean }
  | { item: SharedItem; kind: "replace"; target: string; source: string; backup: string; merge: boolean; createSource: boolean };
export interface SetupPlan { configDir: string; referenceDir: string; steps: SetupStep[] }
export interface SetupOutcome { item: SharedItem; ok: boolean; shared: boolean; message: string }
export interface ApplySetupDependencies {
  symlink?: (target: string, path: string) => Promise<void>;
}

const ITEMS: { item: SharedItem; directory: boolean }[] = [
  { item: "settings.json", directory: false },
  { item: "projects", directory: true },
];

const pad = (value: number) => String(value).padStart(2, "0");
function timestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function sameTarget(a: string, b: string): Promise<boolean> {
  try {
    return await realpath(a) === await realpath(b);
  } catch {
    return false;
  }
}

async function uniqueBackup(target: string, now: number): Promise<string> {
  const base = `${target}.bak-${timestamp(now)}`;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!await stat(candidate)) return candidate;
  }
}

export async function planSharedSetup(
  configDir: string, referenceDir: string, deps: { now?: () => number } = {},
): Promise<SetupPlan> {
  const plan: SetupPlan = { configDir, referenceDir, steps: [] };
  if (await sameTarget(configDir, referenceDir)) return plan;
  const now = (deps.now ?? Date.now)();
  for (const { item, directory } of ITEMS) {
    const source = join(referenceDir, item);
    const target = join(configDir, item);
    const sourceStat = await stat(source);
    if (!sourceStat && !directory) {
      plan.steps.push({ item, kind: "skip", reason: `the reference account has no ${item}` });
      continue;
    }
    if (sourceStat && directory && !await followStat(source).then(s => s.isDirectory(), () => false)) {
      plan.steps.push({ item, kind: "skip", reason: "the reference entry is not a directory" });
      continue;
    }
    const createSource = !sourceStat;
    const targetStat = await stat(target);
    if (!targetStat) {
      plan.steps.push({ item, kind: "link", target, source, createSource });
    } else if (targetStat.isSymbolicLink()) {
      plan.steps.push(await sameTarget(target, source)
        ? { item, kind: "shared" }
        : { item, kind: "skip", reason: "symlink to another location; left unchanged" });
    } else if (directory ? targetStat.isDirectory() : targetStat.isFile()) {
      plan.steps.push({ item, kind: "replace", target, source, backup: await uniqueBackup(target, now), merge: directory, createSource });
    } else {
      plan.steps.push({ item, kind: "skip", reason: "unexpected file type; left unchanged" });
    }
  }
  return plan;
}

export function describeSetupPlan(plan: SetupPlan): { actionable: boolean; text: string } {
  const lines = plan.steps.map(step => {
    const label = step.item === "projects" ? "projects/" : step.item;
    switch (step.kind) {
      case "shared": return `• ${label}: already shared`;
      case "skip": return `• ${label}: ${step.reason}`;
      case "link": return `• ${label}: link ${step.target} → ${step.source}`;
      case "replace": return step.merge
        ? `• ${label}: move ${step.target} to ${step.backup}, copy its files into ${step.source} without overwriting, then link`
        : `• ${label}: move ${step.target} to ${step.backup}, then link ${step.target} → ${step.source}`;
    }
  });
  const actionable = plan.steps.some(step => step.kind === "link" || step.kind === "replace");
  return {
    actionable,
    text: [...lines, "Stop Claude Code sessions that use this account first.",
      ".credentials.json, .claude.json, sessions/ and plugins/ are never touched."].join("\n"),
  };
}

/** Copies files missing from `source`; returns how many existing files were kept untouched. */
async function mergeInto(backup: string, source: string): Promise<number> {
  let conflicts = 0;
  await cp(backup, source, {
    recursive: true, force: false, errorOnExist: false, preserveTimestamps: true,
    filter: async (_from, to) => {
      const existing = await stat(to);
      if (existing && !existing.isDirectory()) {
        conflicts++;
        return false;
      }
      return true;
    },
  });
  return conflicts;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function applySharedSetup(plan: SetupPlan, deps: ApplySetupDependencies = {}): Promise<SetupOutcome[]> {
  const link = deps.symlink ?? ((target: string, path: string) => nodeSymlink(target, path));
  const outcomes: SetupOutcome[] = [];
  for (const step of plan.steps) {
    const { item } = step;
    if (step.kind === "shared") { outcomes.push({ item, ok: true, shared: true, message: "already shared" }); continue; }
    if (step.kind === "skip") { outcomes.push({ item, ok: true, shared: false, message: step.reason }); continue; }
    if (step.kind === "link") {
      try {
        if (step.createSource) await mkdir(step.source, { recursive: true, mode: 0o700 });
        await link(step.source, step.target);
        outcomes.push({ item, ok: true, shared: true, message: "linked" });
      } catch (error) {
        outcomes.push({ item, ok: false, shared: false, message: errorText(error) });
      }
      continue;
    }
    // rename() would silently replace an existing backup, so re-check right before moving.
    if (await stat(step.backup).catch(() => true)) {
      outcomes.push({ item, ok: false, shared: false, message: `backup path ${step.backup} already exists; left unchanged` });
      continue;
    }
    try {
      await rename(step.target, step.backup);
    } catch (error) {
      outcomes.push({ item, ok: false, shared: false, message: errorText(error) });
      continue;
    }
    try {
      if (step.createSource) await mkdir(step.source, { recursive: true, mode: 0o700 });
      const conflicts = step.merge ? await mergeInto(step.backup, step.source) : 0;
      await link(step.source, step.target);
      outcomes.push({
        item, ok: true, shared: true,
        message: step.merge
          ? `merged into ${step.source}${conflicts ? ` (${conflicts} conflict${conflicts === 1 ? "" : "s"} kept only in the backup)` : ""}; backup at ${step.backup}`
          : `linked; previous file at ${step.backup}`,
      });
    } catch (error) {
      // Files already merged into the reference were only added, never overwritten.
      let restored = false;
      try {
        if (!await stat(step.target)) { await rename(step.backup, step.target); restored = true; }
      } catch { /* Reported below; the backup still holds the data. */ }
      outcomes.push({
        item, ok: false, shared: false,
        message: `${errorText(error)}; ${restored ? "original restored" : `original kept at ${step.backup}`}`,
      });
    }
  }
  return outcomes;
}
