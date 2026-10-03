import {
  setCooldown, setNeedsAttention,
  type AccountEntry, type StateFile, type StoreMutation,
} from "./accounts/store.js";
import { nextAfter, selectActive, type Selection } from "./accounts/selector.js";
import { accountForEnv, applyAccountEnv } from "./env.js";
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
  setStatus(text: string | undefined): void;
}
export interface RotationMessage {
  role: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
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
  const status = (selection: Selection) => {
    deps.setStatus(selection.kind === "account"
      ? `claude: ${selection.account.name}${selection.probe ? " (probe)" : ""}`
      : undefined);
  };
  const apply = (state: StateFile, selection: Extract<Selection, { kind: "account" }>) => {
    applyAccountEnv(selection.account, env);
    lastApplied = {
      account: selection.account, probe: selection.probe,
      previousUntil: state.state[selection.account.name]?.cooldownUntil ?? null,
    };
  };
  const select = (state: StateFile, capture: boolean) => {
    checkLaunch(state);
    if (unmanaged) return;
    const selection = selectActive(state, deps.now());
    if (selection.kind === "account") {
      apply(state, selection);
      if (capture) captured = lastApplied;
    } else if (capture) {
      captured = undefined;
    }
    status(selection);
  };

  return {
    async onSessionStart(): Promise<void> {
      unmanaged = false;
      launchChecked = false;
      warnedStore = false;
      captured = undefined;
      lastApplied = undefined;
      launchEnv = { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR };
      try {
        select(await deps.store.load(), false);
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
            deps.setStatus(Number.isFinite(earliest) ? `claude: no accounts · back ${localTime(earliest)}` : undefined);
            const errorMessage = `Claude quota exceeded on all accounts — ${resets.map(item => `${item.name} resets ${localTime(item.until)}`).join(", ")}`;
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
