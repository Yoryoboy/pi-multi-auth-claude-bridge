import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "./accounts/store.js";

export interface ProjectsIssue {
  name: string;
  configDir: string;
  reason: "not-shared" | "missing";
}
export interface ProjectsCheckDependencies {
  realpath?: (path: string) => Promise<string>;
  homeDir?: string;
}

export function projectsReference(accounts: AccountEntry[], homeDir: string) {
  const account = accounts.find(account => account.configDir === null) ?? accounts[0];
  return account ? {
    account,
    path: join(account.configDir ?? join(homeDir, ".claude"), "projects"),
  } : undefined;
}

/** Metadata-only check: never creates directories or reads session contents. */
export async function checkSharedProjects(
  accounts: AccountEntry[], deps: ProjectsCheckDependencies = {},
): Promise<ProjectsIssue[]> {
  const resolve = deps.realpath ?? realpath;
  const issues: ProjectsIssue[] = [];
  try {
    const reference = projectsReference(accounts, deps.homeDir ?? process.env.HOME ?? homedir());
    if (!reference) return [];
    let referencePath: string;
    try {
      referencePath = await resolve(reference.path);
    } catch {
      return [];
    }
    for (const account of accounts) {
      if (account.configDir === null || account === reference.account) continue;
      try {
        if (await resolve(join(account.configDir, "projects")) !== referencePath) {
          issues.push({ name: account.name, configDir: account.configDir, reason: "not-shared" });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          issues.push({ name: account.name, configDir: account.configDir, reason: "missing" });
        }
      }
    }
  } catch {
    // Validation is advisory, including unexpected dependency failures.
  }
  return issues;
}
