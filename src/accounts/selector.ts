import type { AccountEntry, StateFile } from "./store.js";

export type Availability =
  | { kind: "available" }
  | { kind: "cooldown"; until: number; reason: string | null }
  | { kind: "needs-attention"; reason: string };

export type Selection =
  | { kind: "account"; account: AccountEntry; probe: boolean }
  | { kind: "none"; reason: "no-accounts" | "all-need-attention" };

export function priorityOrder(store: StateFile): AccountEntry[] {
  const preferred = store.accounts.find(account => account.name === store.preferred);
  return preferred
    ? [preferred, ...store.accounts.filter(account => account !== preferred)]
    : [...store.accounts];
}

export function availability(store: StateFile, name: string, now: number): Availability {
  const state = store.state[name];
  if (state?.needsAttention != null) {
    return { kind: "needs-attention", reason: state.needsAttention };
  }
  if (state?.cooldownUntil != null && state.cooldownUntil > now) {
    return { kind: "cooldown", until: state.cooldownUntil, reason: state.cooldownReason };
  }
  return { kind: "available" };
}

function selectFrom(store: StateFile, accounts: AccountEntry[], now: number): Selection {
  let probe: AccountEntry | undefined;
  let earliest = Infinity;
  for (const account of accounts) {
    const status = availability(store, account.name, now);
    if (status.kind === "available") return { kind: "account", account, probe: false };
    if (status.kind === "cooldown" && status.until < earliest) {
      probe = account;
      earliest = status.until;
    }
  }
  if (probe) return { kind: "account", account: probe, probe: true };
  return { kind: "none", reason: accounts.length === 0 ? "no-accounts" : "all-need-attention" };
}

export function selectActive(store: StateFile, now: number): Selection {
  return selectFrom(store, priorityOrder(store), now);
}

export function nextAfter(store: StateFile, failedName: string, now: number): Selection {
  return selectFrom(store, priorityOrder(store).filter(account => account.name !== failedName), now);
}
