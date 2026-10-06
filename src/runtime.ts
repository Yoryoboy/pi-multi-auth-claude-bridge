import { homedir } from "node:os";
import { join } from "node:path";
import { projectsReference, type checkSharedProjects } from "./projects-check.js";
import {
  setCooldown, setNeedsAttention, setIdentity,
  type AccountEntry, type StateFile, type StoreMutation,
} from "./accounts/store.js";
import { nextAfter, selectActive, type Selection } from "./accounts/selector.js";
import { accountForEnv, applyAccountEnv } from "./env.js";
import type { AuthStatus } from "./auth-status.js";
import type { UsageResult, Window } from "./usage.js";
import { classifyError } from "./failover/classify.js";
import { computeCooldownUntil } from "./failover/reset.js";

export interface RotationStore {
  load(): Promise<StateFile>;
  mutate(mutation: StoreMutation): Promise<StateFile>;
}
export interface RotationDependencies {
  store: RotationStore;
  env?: NodeJS.ProcessEnv;
  now: () => number;
  notify(message: string, level: "info" | "warning" | "error"): void;
  setStatus(text: string | undefined, level?: "dim" | "warning" | "error"): void;
  getUsage?: (accountName: string, configDir: string | null) => Promise<UsageResult>;
  checkAccount?: (account: AccountEntry, signal: AbortSignal) => Promise<AuthStatus>;
  checkSharedProjects?: typeof checkSharedProjects;
}
export interface RotationMessage {
  role: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
}

function shellQuote(path: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'"'"'`)}'`;
}

function localTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function createRotationRuntime(deps: RotationDependencies) {
  const env = deps.env ?? process.env;
  let unmanaged = false;
  let launchChecked = false;
  let launchEnv: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR };
  let warnedStore = false;
  let captured: { account: AccountEntry; probe: boolean; previousUntil: number | null } | undefined;
  let lastApplied: typeof captured;
  let generation = 0;
  let usageGeneration = 0;
  let activeSelection: Extract<Selection, { kind: "account" }> | undefined;
  let usage: UsageResult | undefined;
  const clearUsage = () => {
    usageGeneration++;
    activeSelection = undefined;
    usage = undefined;
  };
  const renderAccountStatus = () => {
    if (!activeSelection) return;
    const name = `claude: ${activeSelection.account.name}${activeSelection.probe ? " (probe)" : ""}`;
    if (!usage) { deps.setStatus(name); return; }
    if (!usage.ok) { deps.setStatus(`${name} · limits unavailable`, "warning"); return; }
    const percent = (window: Window | null) => window === null ? "--" : `${Math.round(window.usedPercent)}%`;
    const worst = Math.max(usage.fiveHour?.usedPercent ?? 0, usage.weekly?.usedPercent ?? 0);
    deps.setStatus(`${name} · 5h ${percent(usage.fiveHour)} · wk ${percent(usage.weekly)}`,
      worst > 90 ? "error" : worst > 75 ? "warning" : "dim");
  };
  const refreshUsage = () => {
    if (unmanaged || !activeSelection || !deps.getUsage) return;
    const account = activeSelection.account;
    const mine = ++usageGeneration;
    // Never await network work in a request or event handler.
    void (async () => {
      let result: UsageResult;
      try { result = await deps.getUsage!(account.name, account.configDir); }
      catch { result = { ok: false, reason: "unavailable" }; }
      if (mine !== usageGeneration || !activeSelection) return;
      usage = result;
      renderAccountStatus();
    })().catch(() => { /* Advisory usage must not interfere with rotation. */ });
  };
  let warnedAuth = false;
  const pending = new Set<AbortController>();
  const stopChecks = () => {
    generation++;
    for (const controller of pending) controller.abort();
    pending.clear();
  };

  const warnStore = () => {
    if (warnedStore) return;
    warnedStore = true;
    deps.notify("Claude account store unavailable — keeping the last account environment", "warning");
  };
  const checkLaunch = (state: StateFile) => {
    if (launchChecked || state.accounts.length === 0) return;
    launchChecked = true;
    if (launchEnv.CLAUDE_CONFIG_DIR !== undefined && "unregistered" in accountForEnv(state, launchEnv)) {
      unmanaged = true;
      deps.notify("Claude launched with an unregistered CLAUDE_CONFIG_DIR — account rotation disabled for this session", "warning");
      deps.setStatus(undefined);
    }
  };
  const status = (selection: Selection, refresh = false) => {
    if (selection.kind !== "account") {
      clearUsage();
      deps.setStatus(selection.reason === "all-need-attention" ? "claude: no usable accounts" : undefined);
      return;
    }
    const changed = activeSelection?.account.name !== selection.account.name ||
      activeSelection?.account.configDir !== selection.account.configDir;
    if (changed) clearUsage();
    activeSelection = selection;
    renderAccountStatus();
    if (changed || refresh) refreshUsage();
  };
  const apply = (state: StateFile, selection: Extract<Selection, { kind: "account" }>) => {
    applyAccountEnv(selection.account, env);
    lastApplied = {
      account: selection.account, probe: selection.probe,
      previousUntil: state.state[selection.account.name]?.cooldownUntil ?? null,
    };
  };
  const select = (state: StateFile, capture: boolean, refresh = false) => {
    checkLaunch(state);
    if (unmanaged) return;
    const selection = selectActive(state, deps.now());
    if (selection.kind === "account") {
      apply(state, selection);
      if (capture) captured = lastApplied;
    } else if (capture) {
      captured = undefined;
    }
    status(selection, refresh);
  };

  const startCheck = (account: AccountEntry) => {
    if (unmanaged || !deps.checkAccount) return;
    const controller = new AbortController();
    const mine = generation;
    const live = () => mine === generation && !controller.signal.aborted;
    pending.add(controller);
    void (async () => {
      try {
        const result = await deps.checkAccount!(account, controller.signal);
        if (!live()) return;
        if (result.kind === "unavailable") {
          if (!warnedAuth) {
            warnedAuth = true;
            deps.notify("Claude auth status unavailable — account state unchanged", "info");
          }
          return;
        }
        let mismatch: string | undefined;
        const state = await deps.store.mutate(current => {
          if (!live() || !current.accounts.some(a => a.name === account.name && a.configDir === account.configDir)) return current;
          if (result.kind === "logged-out") return setNeedsAttention(current, account.name, "logged out");
          const identity = current.state[account.name]?.identity;
          if (identity == null) return setIdentity(current, account.name, result.identity);
          if (identity !== result.identity) {
            mismatch = `identity changed: ${identity} -> ${result.identity}`;
            return setNeedsAttention(current, account.name, mismatch);
          }
          return current;
        });
        if (!live()) return;
        if (mismatch) deps.notify(`Claude account "${account.name}" needs attention: ${mismatch}`, "warning");
        // Validation updates status without changing an in-flight request's attribution.
        select(state, false);
      } catch {
        if (live()) warnStore();
      } finally {
        pending.delete(controller);
      }
    })();
  };

  const startProjectsCheck = (accounts: AccountEntry[]) => {
    if (unmanaged || accounts.length === 0 || !deps.checkSharedProjects) return;
    const controller = new AbortController();
    const mine = generation;
    pending.add(controller);
    void (async () => {
      try {
        const homeDir = env.HOME ?? homedir();
        const reference = projectsReference(accounts, homeDir);
        if (!reference) return;
        const issues = await deps.checkSharedProjects!(accounts, { homeDir });
        if (mine !== generation || controller.signal.aborted || issues.length === 0) return;
        const warnings = issues.map(issue => {
          const projects = join(issue.configDir, "projects");
          const move = issue.reason === "missing" ? "" : `mv ${shellQuote(projects)} ${shellQuote(`${projects}.bak`)} && `;
          const fix = `${move}ln -s ${shellQuote(reference.path)} ${shellQuote(projects)}`;
          return `Claude account "${issue.name}" does not share session history with "${reference.account.name}"; switching accounts will fail to resume. Fix: ${fix}`;
        });
        deps.notify(warnings.join("\n"), "warning");
      } catch {
        // A failed advisory check must not interfere with account rotation.
      } finally {
        pending.delete(controller);
      }
    })();
  };

  return {
    get unmanaged() { return unmanaged; },
    get appliedAccountName() { return lastApplied?.account.name; },
    checkAccount: startCheck,
    refreshUsage,
    onSessionShutdown() { stopChecks(); clearUsage(); deps.setStatus(undefined); },
    async refresh(): Promise<void> {
      if (unmanaged) return;
      select(await deps.store.load(), false, true);
    },
    async onSessionStart(): Promise<void> {
      stopChecks();
      clearUsage();
      warnedAuth = false;
      const mine = generation;
      unmanaged = false;
      launchChecked = false;
      warnedStore = false;
      captured = undefined;
      lastApplied = undefined;
      launchEnv = { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR };
      try {
        const state = await deps.store.load();
        if (mine !== generation) return;
        select(state, false);
        if (!unmanaged) {
          startProjectsCheck(state.accounts);
          for (const account of state.accounts) startCheck(account);
        }
      } catch {
        warnStore();
      }
    },
    async beforeRequest(): Promise<void> {
      if (unmanaged) return;
      // If reload fails, this request still uses the last applied environment,
      // which may have changed during failover after the previous capture.
      captured = lastApplied;
      try {
        select(await deps.store.load(), true);
      } catch {
        // A request still uses the last applied env, so retain its attribution.
        warnStore();
      }
    },
    async onAssistantMessageEnd<T extends RotationMessage>(message: T): Promise<T | undefined> {
      if (unmanaged || !captured || message.role !== "assistant" ||
          message.provider !== "claude-bridge" || message.stopReason !== "error") return;
      const request = captured;
      const name = request.account.name;
      const classification = classifyError(message.errorMessage);
      try {
        if (classification.kind === "account-problem") {
          await deps.store.mutate(state => setNeedsAttention(state, name, classification.reason));
          deps.notify(`Claude account "${name}" needs attention: ${classification.reason} — rotation stopped for this account`, "error");
        } else if (classification.kind === "exhausted") {
          const now = deps.now();
          const until = computeCooldownUntil(classification, now, request.probe ? request.previousUntil : null);
          const state = await deps.store.mutate(current =>
            setCooldown(current, name, until, classification.limitType ?? "rate_limit"));
          const next = nextAfter(state, name, now);
          if (next.kind === "account" && !next.probe) {
            apply(state, next);
            status(next);
            deps.notify(`Claude account "${name}" exhausted (resets ${localTime(until)}) — switched to "${next.account.name}"`, "warning");
          } else {
            const resets = state.accounts.flatMap(account => {
              const item = state.state[account.name];
              return item?.needsAttention == null && item?.cooldownUntil != null && item.cooldownUntil > now
                ? [{ name: account.name, until: item.cooldownUntil }] : [];
            });
            const earliest = Math.min(...resets.map(item => item.until));
            clearUsage();
            deps.setStatus(Number.isFinite(earliest) ? `claude: no accounts · back ${localTime(earliest)}` : "claude: no usable accounts");
            const detail = resets.length > 0
              ? resets.map(item => `${item.name} resets ${localTime(item.until)}`).join(", ")
              : `no usable accounts (${state.accounts.map(account => `${account.name}: needs attention`).join(", ")})`;
            const errorMessage = `Claude quota exceeded on all accounts — ${detail}`;
            deps.notify(errorMessage, "error");
            return { ...message, errorMessage };
          }
        }
      } catch {
        warnStore();
      }
    },
  };
}
