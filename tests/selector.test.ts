import { describe, expect, it } from "vitest";
import type { AccountState, StateFile } from "../src/accounts/store.js";
import { availability, nextAfter, priorityOrder, selectActive } from "../src/accounts/selector.js";

function fixture(): StateFile {
  return {
    version: 1,
    accounts: [
      { name: "main", configDir: null },
      { name: "work", configDir: "/claude/work" },
      { name: "spare", configDir: "/claude/spare" },
    ],
    preferred: null,
    state: {},
  };
}

function state(patch: Partial<AccountState>): AccountState {
  return { cooldownUntil: null, cooldownReason: null, needsAttention: null, identity: null, ...patch };
}

const now = 1_000;

describe("account selector", () => {
  it("keeps registry order, moving only the preferred account to the front without mutation", () => {
    const store = fixture();
    expect(priorityOrder(store)).toEqual(store.accounts);
    store.preferred = "work";
    const before = structuredClone(store);
    expect(priorityOrder(store).map(a => a.name)).toEqual(["work", "main", "spare"]);
    expect(selectActive(store, now)).toEqual({ kind: "account", account: store.accounts[1], probe: false });
    expect(store).toEqual(before);
  });

  it("reports cooldown metadata, skips preferred cooldown, and expires at the exact boundary", () => {
    const store = fixture();
    store.preferred = "work";
    store.state.work = state({ cooldownUntil: now + 1, cooldownReason: "quota" });
    expect(availability(store, "work", now)).toEqual({ kind: "cooldown", until: now + 1, reason: "quota" });
    expect(selectActive(store, now)).toEqual({ kind: "account", account: store.accounts[0], probe: false });
    expect(availability(store, "work", now + 1)).toEqual({ kind: "available" });
    expect(availability(store, "work", now + 2)).toEqual({ kind: "available" });
    expect(selectActive(store, now + 1)).toEqual({ kind: "account", account: store.accounts[1], probe: false });
    store.state.work.cooldownReason = null;
    expect(availability(store, "work", now)).toEqual({ kind: "cooldown", until: now + 1, reason: null });
  });

  it("never selects needs-attention accounts, even with an earlier cooldown", () => {
    const store = fixture();
    store.state.main = state({ needsAttention: "login", cooldownUntil: now + 1 });
    store.state.work = state({ cooldownUntil: now + 20 });
    store.state.spare = state({ cooldownUntil: now + 10 });
    expect(availability(store, "main", now)).toEqual({ kind: "needs-attention", reason: "login" });
    expect(selectActive(store, now)).toEqual({ kind: "account", account: store.accounts[2], probe: true });
    expect(availability(store, "main", now + 100)).toEqual({ kind: "needs-attention", reason: "login" });
  });

  it("prefers an available account over a probe and breaks probe ties in priority order", () => {
    const store = fixture();
    store.preferred = "work";
    store.state.main = state({ cooldownUntil: now + 10 });
    store.state.work = state({ cooldownUntil: now + 10 });
    expect(selectActive(store, now)).toEqual({ kind: "account", account: store.accounts[2], probe: false });
    store.state.spare = state({ cooldownUntil: now + 20 });
    expect(selectActive(store, now)).toEqual({ kind: "account", account: store.accounts[1], probe: true });
  });

  it("distinguishes an empty registry from all accounts needing attention", () => {
    const store = fixture();
    for (const account of store.accounts) store.state[account.name] = state({ needsAttention: "" });
    expect(selectActive(store, now)).toEqual({ kind: "none", reason: "all-need-attention" });
    expect(selectActive({ ...store, accounts: [] }, now)).toEqual({ kind: "none", reason: "no-accounts" });
  });

  it("excludes the failed account, falls back to a probe, and does not mutate the store", () => {
    const store = fixture();
    const before = structuredClone(store);
    expect(nextAfter(store, "main", now)).toEqual({ kind: "account", account: store.accounts[1], probe: false });
    expect(store).toEqual(before);
    store.state.work = state({ needsAttention: "billing" });
    store.state.spare = state({ cooldownUntil: now + 20 });
    expect(nextAfter(store, "main", now)).toEqual({ kind: "account", account: store.accounts[2], probe: true });
    store.state.spare.needsAttention = "login";
    expect(nextAfter(store, "main", now)).toEqual({ kind: "none", reason: "all-need-attention" });
    expect(nextAfter({ ...store, accounts: [store.accounts[0]] }, "main", now)).toEqual({ kind: "none", reason: "no-accounts" });
  });
});
