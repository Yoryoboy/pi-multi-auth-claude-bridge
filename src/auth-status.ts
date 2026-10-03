import { execFile as nodeExecFile } from "node:child_process";
import type { AccountEntry } from "./accounts/store.js";

export type AuthStatus =
  | { kind: "ok"; identity: string }
  | { kind: "logged-out" }
  | { kind: "unavailable"; reason: string };
export interface AuthStatusDependencies {
  execFile?: typeof nodeExecFile;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Only metadata leaves this boundary; never expose stdout, stderr or errors. */
export function checkAccount(account: AccountEntry, deps: AuthStatusDependencies = {}): Promise<AuthStatus> {
  const env = { ...(deps.env ?? process.env) };
  if (account.configDir === null) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = account.configDir;
  return new Promise(resolve => {
    const unavailable = (reason: string) => resolve({ kind: "unavailable", reason });
    try {
      const child = (deps.execFile ?? nodeExecFile)("claude", ["auth", "status"], {
        env, timeout: 15_000, signal: deps.signal, maxBuffer: 64 * 1024,
      }, (error, stdout) => {
        if (error?.code === "ENOENT") return unavailable("claude binary not found");
        if (error?.killed) return unavailable("auth status timed out");
        if (deps.signal?.aborted) return unavailable("auth status aborted");
        let value: unknown;
        try { value = JSON.parse(stdout); } catch { return unavailable("auth status returned non-JSON output"); }
        if (value === null || typeof value !== "object") return unavailable("invalid auth status");
        const data = value as Record<string, unknown>;
        // Claude may exit nonzero when logged out, while still returning JSON.
        if (data.loggedIn === false) return resolve({ kind: "logged-out" });
        if (!error && data.loggedIn === true && typeof data.email === "string") {
          const match = /^([^@\s]+)@[^@\s]+$/.exec(data.email);
          if (match) return resolve({ kind: "ok", identity: match[1] });
        }
        unavailable("invalid auth status");
      });
      child.stdin?.end();
    } catch {
      unavailable("auth status could not start");
    }
  });
}
