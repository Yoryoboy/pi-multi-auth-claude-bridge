import { availability, priorityOrder } from "./accounts/selector.js";
import type { RotationStore } from "./runtime.js";
import type { UsageResult } from "./usage.js";

export interface AccountMenuUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface AccountMenuDependencies {
  store: Pick<RotationStore, "load">;
  ui: AccountMenuUI;
  dispatch: (args: string) => Promise<void>;
  getUsage: (name: string, configDir: string | null) => Promise<UsageResult>;
  appliedAccountName: () => string | undefined;
  now: () => number;
}

const time = (until: number) => {
  const date = new Date(until);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

export async function runAccountMenu(deps: AccountMenuDependencies): Promise<void> {
  while (true) {
    const state = await deps.store.load();
    const accounts = priorityOrder(state);
    const now = deps.now();
    const active = deps.appliedAccountName();
    // Use the shared cache, concurrently, so uncached accounts don't add serial delays.
    const rows = await Promise.all(accounts.map(async account => {
      const status = availability(state, account.name, now);
      const label = active === account.name ? "active"
        : state.preferred === account.name ? "preferred"
        : status.kind === "cooldown" ? `cooldown → ${time(status.until)}`
        : status.kind === "needs-attention" ? "needs attention" : "available";
      const parts = [account.name, state.state[account.name]?.identity ?? account.configDir ?? "default (~/.claude)", label];
      try {
        const usage = await deps.getUsage(account.name, account.configDir);
        if (usage.ok) {
          if (usage.fiveHour) parts.push(`5h ${Math.round(usage.fiveHour.usedPercent)}%`);
          if (usage.weekly) parts.push(`wk ${Math.round(usage.weekly.usedPercent)}%`);
        }
      } catch { /* Usage is advisory; keep the account selectable on failure. */ }
      return parts.join(" · ");
    }));
    const choice = await deps.ui.select("Claude accounts", [
      ...rows, "Add account", ...(state.preferred !== null ? ["Clear preference"] : []), "Close",
    ]);
    if (choice === undefined || choice === "Close") return;
    if (choice === "Add account") {
      await addAccount(deps);
      continue;
    }
    if (choice === "Clear preference") {
      await deps.dispatch("clear");
      continue;
    }
    const index = rows.indexOf(choice);
    if (index < 0) continue;
    const name = accounts[index].name;
    const action = await deps.ui.select(name, ["Use", "Reset", "Remove", "Back"]);
    if (action === "Use" || action === "Reset") {
      await deps.dispatch(`${action.toLowerCase()} ${name}`);
    } else if (action === "Remove" && await deps.ui.confirm("Remove account?", `Remove ${name} from Claude account rotation?`)) {
      await deps.dispatch(`remove ${name}`);
    }
  }
}

async function addAccount(deps: AccountMenuDependencies): Promise<void> {
  const input = await deps.ui.input("Account name");
  if (input === undefined) return;
  const name = input.trim();
  if (!name || /\s/.test(name)) {
    deps.ui.notify("Account name must be nonempty and contain no whitespace.", "error");
    return;
  }
  const choice = await deps.ui.select("Config dir", ["default (~/.claude)", "Custom path…"]);
  if (choice === undefined) return;
  if (choice === "default (~/.claude)") {
    await deps.dispatch(`add ${name} default`);
  } else if (choice === "Custom path…") {
    const path = await deps.ui.input("Config path");
    if (path === undefined) return;
    // The typed command splits on whitespace and cannot represent these paths.
    if (!path || /\s/.test(path)) {
      deps.ui.notify("Config path must be nonempty and contain no whitespace. Use a path without spaces.", "error");
      return;
    }
    await deps.dispatch(`add ${name} ${path}`);
  }
}
