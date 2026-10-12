import { stat } from "node:fs/promises";
import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";
import {
  addAccount, removeAccount, setPreferred, clearCooldown, setNeedsAttention, setIdentity, normalizeConfigDir,
  type AccountEntry,
} from "./accounts/store.js";
import { availability, priorityOrder } from "./accounts/selector.js";
import type { createRotationRuntime, RotationStore } from "./runtime.js";

const usage = "Usage: list | use <name> | clear | reset <name> | add <name> <dir|default> | remove <name>";
export interface CommandDependencies {
  store: RotationStore;
  runtime: ReturnType<typeof createRotationRuntime>;
  now: () => number;
  checkAccount: (account: AccountEntry) => void;
  directoryExists?: (directory: string) => Promise<boolean>;
}
const time = (until: number) => {
  const date = new Date(until);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
export const shellQuote = (value: string) => /^[\w/.-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export function createAccountCommand(deps: CommandDependencies): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description: "Manage Claude subscription account rotation",
    async getArgumentCompletions(prefix) {
      const match = /^(use|reset|remove)\s+([^\s]*)$/.exec(prefix);
      if (!match) return null;
      try {
        return (await deps.store.load()).accounts.filter(a => a.name.startsWith(match[2]))
          .map(a => ({ value: `${match[1]} ${a.name}`, label: a.name }));
      } catch { return null; }
    },
    async handler(args, ctx) {
      // Notifications are supported in RPC too; never open dialogs or custom UI.
      const notify = (text: string, level: "info" | "error" = "info") => ctx.ui?.notify?.(text, level);
      try {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const subcommand = parts[0] ?? "list";
        const arity: Record<string, number> = { list: 0, use: 1, clear: 0, reset: 1, add: 2, remove: 1 };
        if (!Object.hasOwn(arity, subcommand) || parts.length !== (parts.length === 0 ? 0 : arity[subcommand] + 1)) {
          notify(usage, "error"); return;
        }
        if (["use", "clear", "reset"].includes(subcommand) && deps.runtime.unmanaged) {
          notify("Claude rotation is disabled for this session: launched with an unregistered CLAUDE_CONFIG_DIR", "error");
          return;
        }
        const name = parts[1];
        if (subcommand === "list") {
          const state = await deps.store.load();
          const lines = priorityOrder(state).map(account => {
            const item = state.state[account.name];
            const available = availability(state, account.name, deps.now());
            const labels: string[] = [];
            if (deps.runtime.appliedAccountName === account.name) labels.push("active");
            if (state.preferred === account.name) labels.push("preferred");
            if (available.kind === "cooldown") labels.push(`cooldown → ${time(available.until)} (${available.reason ?? "quota"})`);
            if (available.kind === "needs-attention") labels.push(available.reason === "logged out" ? "logged out" : `needs attention: ${available.reason}`);
            return `${account.name} · ${account.configDir ?? "default"} · ${item?.identity ?? "identity unknown"} · ${labels.join(" · ") || "available"}`;
          });
          notify(lines.join("\n") || "No Claude accounts registered");
          return;
        }
        if (subcommand === "add") {
          const configDir = normalizeConfigDir(parts[2] === "default" ? null : parts[2]);
          const exists = deps.directoryExists ?? (async (dir: string) => (await stat(dir)).isDirectory());
          if (configDir !== null && !await exists(configDir)) throw new Error("Config directory does not exist");
          await deps.store.mutate(state => addAccount(state, name, configDir));
          // The add-account wizard reports login guidance and the final summary.
          deps.checkAccount({ name, configDir });
          return;
        }
        await deps.store.mutate(state => {
          if (subcommand === "use") return setPreferred(state, name);
          if (subcommand === "clear") return setPreferred(state, null);
          // Forget the cached identity too: otherwise a deliberate re-login is flagged again on the next check.
          if (subcommand === "reset") return setIdentity(setNeedsAttention(clearCooldown(state, name), name, null), name, null);
          return removeAccount(state, name);
        });
        await deps.runtime.refresh();
        if (subcommand === "reset") {
          const account = (await deps.store.load()).accounts.find(a => a.name === name);
          if (account) deps.checkAccount(account);
        }
        notify(`Claude account ${subcommand}${name ? `: ${name}` : ""} applied; automatic failover remains enabled.`);
      } catch (error) {
        notify(error instanceof Error ? error.message : "Account operation failed", "error");
      }
    },
  };
}
