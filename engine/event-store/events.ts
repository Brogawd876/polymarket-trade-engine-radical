import type { DecisionFeatureSnapshot } from "../decision-features.ts";
import type { RiskDecision } from "../bot-core/risk-gate.ts";
import type { StrategyIntent } from "../bot-core/strategy-intent.ts";

export const EVENT_SCHEMA_VERSION = 1 as const;

export type ProfitEventType =
  | "market_book_snapshot"
  | "market_book_delta"
  | "market_trade"
  | "market_status_change"
  | "spread_depth_snapshot"
  | "external_trade_tick"
  | "external_price_tick"
  | "external_l2_snapshot"
  | "external_l2_delta"
  | "feed_freshness_snapshot"
  | "chainlink_update"
  | "resolution_anchor"
  | "price_to_beat"
  | "settlement_result"
  | "strategy_decision"
  | "model_probability"
  | "calibrated_probability"
  | "market_implied_probability"
  | "edge_estimate"
  | "no_trade_reason"
  | "risk_gate_decision"
  | "regime_label"
  | "jump_flag"
  | "order_intent"
  | "order_submitted"
  | "order_acknowledged"
  | "order_canceled"
  | "cancel_acknowledged"
  | "order_filled"
  | "partial_fill"
  | "order_expired"
  | "maker_taker_classification"
  | "fee_rebate_estimate"
  | "queue_estimate"
  | "size_ahead_estimate"
  | "trade_through_event"
  | "fill_probability_estimate"
  | "adverse_selection_flag"
  | "markout_1s"
  | "markout_5s"
  | "markout_30s"
  | "settlement_markout"
  | "run_started"
  | "run_completed"
  | "code_commit"
  | "config_hash"
  | "strategy_version"
  | "env_profile"
  | "dependency_versions"
  | "host_latency_profile"
  | "feed_health"
  | "operator_action"
  | "recorder_started"
  | "recorder_completed"
  | "market_resolved_for_recording"
  | "feed_connected"
  | "feed_disconnected"
  | "feed_decode_error"
  | "raw_market_message"
  | "last_trade_price";

export type BookLevel = [price: number, size: number];

export type MarketBookPayload = {
  conditionId?: string | null;
  clobTokenIds?: [string, string] | null;
  tokenId?: string | null;
  side?: "UP" | "DOWN" | "BOTH";
  bids?: BookLevel[];
  asks?: BookLevel[];
  bidChanges?: BookLevel[];
  askChanges?: BookLevel[];
  bestBid?: number | null;
  bestAsk?: number | null;
  bestBidUp?: number | null;
  bestAskUp?: number | null;
  bestBidDown?: number | null;
  bestAskDown?: number | null;
  spreadUp?: number | null;
  spreadDown?: number | null;
  depthUpUsd?: number | null;
  depthDownUsd?: number | null;
  feeRateBps?: number | null;
  raw?: unknown;
};

export type ExternalFeedPayload = {
  exchange: string;
  symbol?: string;
  price?: number | null;
  volume?: number | null;
  bid?: number | null;
  ask?: number | null;
  bids?: BookLevel[];
  asks?: BookLevel[];
  quality?: string;
  ageMs?: number | null;
  lagMs?: number | null;
  raw?: unknown;
};

export type SettlementPayload = {
  price?: number | null;
  priceToBeat?: number | null;
  openPrice?: number | null;
  closePrice?: number | null;
  direction?: "UP" | "DOWN" | "TIE";
  roundId?: string | null;
  rawOracleAnswer?: string | null;
  answeredInRound?: string | null;
  chainUpdatedAtMs?: number | null;
  localReceivedAtMs?: number | null;
  oracleLagMs?: number | null;
  quality?: string | null;
  sourceType?: string | null;
  contractAddress?: string | null;
  payout?: number | null;
  pnl?: number | null;
};

export type StrategyPayload = {
  decisionFeature?: DecisionFeatureSnapshot;
  intent?: StrategyIntent;
  decision?: RiskDecision;
  approved?: boolean | null;
  reasons?: string[];
  probability?: number | null;
  calibratedProbability?: number | null;
  impliedProbability?: number | null;
  edge?: number | null;
  noTradeReason?: string | null;
  regime?: string | null;
  jump?: boolean | null;
};

export type ExecutionPayload = {
  intentId?: string;
  orderId?: string;
  tokenId?: string;
  side?: "UP" | "DOWN";
  action?: "buy" | "sell" | "cancel";
  price?: number;
  shares?: number;
  orderType?: string;
  status?: string;
  makerTaker?: "maker" | "taker" | "unknown";
  feeEstimateUsd?: number | null;
  rebateEstimateUsd?: number | null;
  actualFeeUsd?: number | null;
  error?: string;
};

export type FillRealismPayload = {
  orderId?: string;
  tokenId?: string;
  side?: "UP" | "DOWN";
  action?: "buy" | "sell";
  price?: number;
  shares?: number;
  queuePosition?: number | null;
  sizeAhead?: number | null;
  tradeThrough?: boolean;
  fillProbability?: number | null;
  adverseSelection?: boolean | null;
  modelVersion?: string;
  reason?: string;
};

export type MarkoutPayload = {
  orderId?: string;
  side?: "UP" | "DOWN";
  action?: "buy" | "sell";
  fillPrice?: number;
  fillTsMs?: number;
  horizonMs?: number;
  referencePrice?: number | null;
  value?: number | null;
  reason?: "missing_reference" | "missing_horizon" | "missing_fill";
};

export type OperationsPayload = {
  mode?: "live" | "sim" | "replay";
  status?: "started" | "completed" | "failed" | "canceled";
  branch?: string;
  commitSha?: string;
  configHash?: string;
  strategyVersion?: string;
  envProfile?: string;
  dependencyVersions?: Record<string, string>;
  latencyMs?: number | null;
  feed?: string;
  quality?: string;
  action?: string;
  reason?: string;
  error?: string;
};

export type ProfitEventPayload =
  | MarketBookPayload
  | ExternalFeedPayload
  | SettlementPayload
  | StrategyPayload
  | ExecutionPayload
  | FillRealismPayload
  | MarkoutPayload
  | OperationsPayload
  | Record<string, unknown>;

export type ProfitEventEnvelope<TPayload extends ProfitEventPayload = ProfitEventPayload> = {
  eventId: string;
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  runId: string;
  sessionId: string;
  roundId?: string;
  slug?: string;
  eventType: ProfitEventType;
  source: string;
  sourceTsMs?: number | null;
  receivedTsMs: number;
  processedTsMs: number;
  monotonicNs?: string;
  commitSha: string;
  strategyId?: string;
  configHash?: string;
  payload: TPayload;
};

export type ProfitEventInput<TPayload extends ProfitEventPayload = ProfitEventPayload> = {
  eventId?: string;
  roundId?: string;
  slug?: string;
  eventType: ProfitEventType;
  source: string;
  sourceTsMs?: number | null;
  receivedTsMs?: number;
  processedTsMs?: number;
  monotonicNs?: bigint | string;
  strategyId?: string;
  configHash?: string;
  payload: TPayload;
};

export type ProfitEventContext = {
  runId: string;
  sessionId: string;
  commitSha: string;
  nowMs?: () => number;
  monotonicNs?: () => bigint;
};

export function createProfitEvent<TPayload extends ProfitEventPayload>(
  context: ProfitEventContext,
  input: ProfitEventInput<TPayload>,
): ProfitEventEnvelope<TPayload> {
  const receivedTsMs = input.receivedTsMs ?? context.nowMs?.() ?? Date.now();
  const processedTsMs = input.processedTsMs ?? receivedTsMs;
  const monotonic =
    input.monotonicNs ??
    (() => {
      try {
        return context.monotonicNs?.() ?? process.hrtime.bigint();
      } catch {
        return undefined;
      }
    })();

  return {
    eventId: input.eventId ?? crypto.randomUUID(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    runId: context.runId,
    sessionId: context.sessionId,
    roundId: input.roundId,
    slug: input.slug,
    eventType: input.eventType,
    source: input.source,
    sourceTsMs: input.sourceTsMs,
    receivedTsMs,
    processedTsMs,
    monotonicNs: monotonic === undefined ? undefined : String(monotonic),
    commitSha: context.commitSha,
    strategyId: input.strategyId,
    configHash: input.configHash,
    payload: input.payload,
  };
}

export function gitCommitFromEnv(): string {
  return process.env.GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "local";
}
