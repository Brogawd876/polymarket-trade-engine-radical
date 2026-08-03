import { createHash } from "crypto";
import type { LedgerSnapshot } from "./ledger.ts";

export type ContinuousReplayState = {
  schemaVersion: 1;
  marketSequence: number;
  ledger: LedgerSnapshot;
  openOrderIntentIds: string[];
  pendingTradeIds: string[];
  unsettledMarketIds: string[];
  equityHighWatermark: string;
  drawdown: string;
  sessionLoss: string;
  strategyState: Record<string, unknown>;
  modelState: Record<string, unknown>;
  orderChurnState: Record<string, number>;
  capitalUtilization: string;
  previousStateHash: string;
  stateHash: string;
};

function hashState(
  state: Omit<ContinuousReplayState, "stateHash">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex");
}

export function verifyContinuousReplayState(
  state: ContinuousReplayState,
): void {
  const { stateHash, ...withoutHash } = state;
  if (stateHash !== hashState(withoutHash)) {
    throw new Error("continuous replay state hash mismatch");
  }
}

export function createContinuousReplayState(
  input: Omit<
    ContinuousReplayState,
    "schemaVersion" | "marketSequence" | "previousStateHash" | "stateHash"
  >,
): ContinuousReplayState {
  const withoutHash = {
    schemaVersion: 1 as const,
    marketSequence: 0,
    ...structuredClone(input),
    previousStateHash: "GENESIS",
  };
  return { ...withoutHash, stateHash: hashState(withoutHash) };
}

export function carryReplayState(
  previous: ContinuousReplayState,
  next: Omit<
    ContinuousReplayState,
    "schemaVersion" | "marketSequence" | "previousStateHash" | "stateHash"
  >,
): ContinuousReplayState {
  verifyContinuousReplayState(previous);
  const withoutHash = {
    schemaVersion: 1 as const,
    marketSequence: previous.marketSequence + 1,
    ...structuredClone(next),
    previousStateHash: previous.stateHash,
  };
  return { ...withoutHash, stateHash: hashState(withoutHash) };
}
