import type { StrategyIntent } from "./bot-core/strategy-intent.ts";

export type OperatingMode =
  | "replay"
  | "shadow"
  | "paper"
  | "micro-live"
  | "pilot";

export type SubmissionTarget = "simulated" | "exchange";

export type IntentState =
  | "recorded"
  | "risk_approved"
  | "submitting"
  | "retry_pending"
  | "acknowledged"
  | "blocked"
  | "failed"
  | "expired"
  | "canceled"
  | "filled";

export type IntentStateRecord = {
  intent: StrategyIntent;
  state: IntentState;
  updatedAtMs: number;
  reason?: string;
};

export type SubmissionDecision = {
  approved: boolean;
  reason: string | null;
};

const TERMINAL_STATES = new Set<IntentState>([
  "blocked",
  "failed",
  "expired",
  "canceled",
  "filled",
]);

const ALLOWED_TRANSITIONS: Record<IntentState, ReadonlySet<IntentState>> = {
  recorded: new Set(["risk_approved", "blocked", "failed", "expired"]),
  risk_approved: new Set(["submitting", "retry_pending", "blocked", "failed", "expired"]),
  submitting: new Set(["retry_pending", "acknowledged", "failed"]),
  retry_pending: new Set(["risk_approved", "blocked", "failed", "expired"]),
  acknowledged: new Set(["canceled", "failed", "expired", "filled"]),
  blocked: new Set(),
  failed: new Set(),
  expired: new Set(),
  canceled: new Set(),
  filled: new Set(),
};

/**
 * Phase A authority kernel.
 *
 * It owns operating mode, submission authority, and intent transitions. Live
 * exchange submission is deliberately unavailable until the later promotion
 * gates and a separate authorization mechanism are implemented.
 */
export class TradingKernel {
  private readonly _intents = new Map<string, IntentStateRecord>();

  constructor(
    readonly mode: OperatingMode,
    private readonly _nowMs: () => number = Date.now,
  ) {}

  assertRuntimeCompatible(opts: {
    replayFile: boolean;
    exchangeClientRequested: boolean;
  }): void {
    if (opts.replayFile !== (this.mode === "replay")) {
      throw new Error(
        `operating mode ${this.mode} is incompatible with replayFile=${opts.replayFile}`,
      );
    }

    if (opts.exchangeClientRequested) {
      const decision = this.authorizeSubmission("exchange");
      if (!decision.approved) {
        throw new Error(decision.reason ?? "exchange submission is disabled");
      }
    }
  }

  authorizeSubmission(target: SubmissionTarget): SubmissionDecision {
    if (target === "exchange") {
      return {
        approved: false,
        reason:
          "live exchange submission is disabled pending Gate 5 evidence and separate explicit authorization",
      };
    }

    if (this.mode === "shadow") {
      return {
        approved: false,
        reason: "shadow mode cannot submit orders, including simulated orders",
      };
    }

    if (this.mode === "micro-live" || this.mode === "pilot") {
      return {
        approved: false,
        reason: `${this.mode} mode cannot fall back to simulated submission`,
      };
    }

    return { approved: true, reason: null };
  }

  recordIntent(intent: StrategyIntent): IntentStateRecord {
    if (this._intents.has(intent.id)) {
      throw new Error(`intent invariant violation: duplicate intent id ${intent.id}`);
    }
    const record: IntentStateRecord = {
      intent,
      state: "recorded",
      updatedAtMs: this._nowMs(),
    };
    this._intents.set(intent.id, record);
    return { ...record };
  }

  restoreIntent(
    intent: StrategyIntent,
    state: IntentState,
    reason = "restored from durable session state",
  ): IntentStateRecord {
    if (this._intents.has(intent.id)) {
      throw new Error(`intent invariant violation: duplicate intent id ${intent.id}`);
    }
    const record: IntentStateRecord = {
      intent,
      state,
      updatedAtMs: this._nowMs(),
      reason,
    };
    this._intents.set(intent.id, record);
    return { ...record };
  }

  transitionIntent(
    intentId: string,
    nextState: IntentState,
    reason?: string,
  ): IntentStateRecord {
    const current = this._intents.get(intentId);
    if (!current) {
      throw new Error(`intent invariant violation: unknown intent ${intentId}`);
    }
    if (current.state === nextState) return { ...current };
    if (TERMINAL_STATES.has(current.state)) {
      throw new Error(
        `intent invariant violation: terminal intent ${intentId} cannot transition from ${current.state} to ${nextState}`,
      );
    }
    if (!ALLOWED_TRANSITIONS[current.state].has(nextState)) {
      throw new Error(
        `intent invariant violation: ${intentId} cannot transition from ${current.state} to ${nextState}`,
      );
    }
    const updated: IntentStateRecord = {
      ...current,
      state: nextState,
      updatedAtMs: this._nowMs(),
      reason,
    };
    this._intents.set(intentId, updated);
    return { ...updated };
  }

  intentState(intentId: string): IntentStateRecord | null {
    const record = this._intents.get(intentId);
    return record ? { ...record } : null;
  }

  intentStates(): IntentStateRecord[] {
    return [...this._intents.values()].map((record) => ({ ...record }));
  }
}

export function deriveOperatingMode(opts: {
  replayFile?: string;
  productionRequested?: boolean;
}): OperatingMode {
  if (opts.replayFile) return "replay";
  if (opts.productionRequested) return "micro-live";
  return "paper";
}
