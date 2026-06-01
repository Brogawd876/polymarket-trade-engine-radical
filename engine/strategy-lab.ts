import { readFileSync } from "fs";
import { EarlyBird } from "./early-bird.ts";
import { ReplayRunner, VirtualClock, type TelemetryEvent, type TelemetrySink } from "./bot-core/index.ts";
import { listStrategyVariants, resolveStrategySelection, type StrategyVariant } from "./strategy/index.ts";
import { validateReplayFixture } from "./server/helpers/replay-fixtures.ts";
import { calculateBrierScore, calculateLogLoss } from "../utils/math.ts";
import { log } from "./log.ts";
import {
  appendSettlementReference,
  calculateMarkouts,
  extractReferencePricesFromReplayEvents,
  summarizeMarkouts,
  type FillForMarkout,
  type MarkoutSummary,
  type ReferencePricePoint,
} from "./replay/markout.ts";
import { ConservativeFillScorer, type FillScoreResult } from "./replay/fill-scoring.ts";
import { extractClobTokenIdsFromRawL2 } from "./replay/paired-token-mapping.ts";
import type { DecisionFeatureSnapshot } from "./decision-features.ts";
import type { CounterfactualRiskMode } from "./replay/counterfactual-risk-gate.ts";

export type StrategyLabBatchState = "queued" | "running" | "completed" | "failed" | "canceled";
export type StrategyLabRunStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type StrategyLabVerdict = "win" | "loss" | "flat" | "no_trade" | "blocked" | "failed";

export type StrategyLabBatchRequest = {
  strategies?: string[];
  variants?: string[];
  files: string[];
  l2Files?: Record<string, string>; // mapping from fixture path to l2 log path
  riskMode?: CounterfactualRiskMode;
  bypassReasons?: string[];
  continuousBankroll?: boolean;
  /** Optional callback invoked after each run completes (before evidence is stripped). */
  onRunComplete?: (run: StrategyLabRunResult) => void;
  /** Suppress replay console/file logs. Does not affect telemetry or calibration evidence. */
  quiet?: boolean;
};

export type ConservativeFillEvidencePoint = {
  orderId: string;
  tokenId: string;
  action: "buy" | "sell";
  side: "UP" | "DOWN";
  price: number;
  shares: number;
  placedTsMs: number;
  fillTsMs?: number;
  verdict: string;
  markouts: { "1s": number | null; "5s": number | null; "30s": number | null; };
  adverseSelection: boolean | null;
  decisionFeature?: DecisionFeatureSnapshot;
};

export type ConservativeFillReport = {
  conservativeFillEvidenceAvailable: boolean;
  conservativeFillEvidenceSource: "raw_l2_event_store" | "unavailable";
  conservativeFillVerdictCounts: {
    no_fill: number;
    touch_only: number;
    probable_fill: number;
    trade_through_fill: number;
    unknown_insufficient_data: number;
  };
  conservativeFillUnavailableReasons: Record<string, number>;
  conservativeMarkout1sAvg: number | null;
  conservativeMarkout5sAvg: number | null;
  conservativeMarkout30sAvg: number | null;
  conservativeAdverseSelectionRate: number | null;
  usableEvidenceCount: number;
  evaluatedFillCount: number;
  eligibleFillCount: number;
  confirmedFillCount: number;
  rejectedFillCount: number;
  conservativeFillWarning?: string;
  evidence?: ConservativeFillEvidencePoint[];
};

export type StrategyLabRunResult = {
  id: string;
  strategy: string;
  baseStrategy: string;
  variantLabel: string;
  paperEligible: boolean;
  file: string;
  slug: string | null;
  status: StrategyLabRunStatus;
  pnl: number | null;
  direction: "UP" | "DOWN" | null;
  openPrice: number | null;
  closePrice: number | null;
  counts: {
    intents: number;
    allowed: number;
    blocked: number;
    fills: number;
    problems: number;
    settlements: number;
  };
  verdict: StrategyLabVerdict | null;
  brierScore: number | null;
  logLoss: number | null;
  execution: ExecutionQualitySummary;
  error?: string;
};

export type ExecutionQualitySummary = {
  fillRate: number | null;
  cancelRate: number | null;
  takerFeeSpend: number;
  makerRebateEstimate: number;
  grossEdgeCapture: number | null;
  turnover: number;
  maxDrawdown: number;
  markouts: {
    oneSecond: number | null;
    fiveSecond: number | null;
    thirtySecond: number | null;
    settlement: number | null;
    samples: number;
    unavailableCount: number;
    unavailableReasons: Record<string, number>;
  };
  conservativeFill: ConservativeFillReport;
};

export type StrategyLabVariantSummary = {
  strategy: string;
  baseStrategy: string;
  label: string;
  paperEligible: boolean;
  runs: number;
  completed: number;
  failed: number;
  canceled: number;
  wins: number;
  losses: number;
  noTrades: number;
  blockedVerdicts: number;
  tradeCount: number;
  winRate: number | null;
  tradeRate: number | null;
  totalPnl: number;
  avgPnl: number | null;
  bestPnl: number | null;
  worstPnl: number | null;
  conservativeAdjustedTotalPnl: number;
  conservativeAdjustedAvgPnl: number | null;
  conservativeAdjustedBestPnl: number | null;
  conservativeAdjustedWorstPnl: number | null;
  blocked: number;
  problems: number;
  brierScore: number | null;
  logLoss: number | null;
  avgFillRate: number | null;
  avgCancelRate: number | null;
  avgMarkout1s: number | null;
  avgMarkout5s: number | null;
  avgMarkout30s: number | null;
  avgSettlementMarkout: number | null;
  markoutSampleCount: number;
  markoutUnavailableCount: number;
  avgTurnover: number | null;
  conservativeFill: {
    noFillCount: number;
    touchOnlyCount: number;
    probableFillCount: number;
    tradeThroughFillCount: number;
    confirmedFillCount: number;
    rejectedFillCount: number;
    unknownInsufficientDataCount: number;
    usableEvidenceRate: number | null;
    usableEvidenceCount: number;
    evaluatedFillCount: number;
    eligibleFillCount: number;
    avgMarkout1s: number | null;
    avgMarkout5s: number | null;
    avgMarkout30s: number | null;
    adverseSelectionRate: number | null;
  };
  score: number;
};

export type StrategyLabRecommendation = {
  strategy: string;
  label: string;
  score: number;
  readyForPaper: boolean;
  rationale: string[];
} | null;

export type StrategyLabBatchSummary = {
  totalRuns: number;
  completed: number;
  failed: number;
  canceled: number;
  winRate: number | null;
  totalPnl: number;
  avgPnl: number | null;
  bestPnl: number | null;
  worstPnl: number | null;
  conservativeAdjustedTotalPnl: number;
  conservativeAdjustedAvgPnl: number | null;
  conservativeAdjustedBestPnl: number | null;
  conservativeAdjustedWorstPnl: number | null;
  blocked: number;
  problems: number;
  byStrategy: StrategyLabVariantSummary[];
  recommendation: StrategyLabRecommendation;
};

export type StrategyLabBatch = {
  id: string;
  state: StrategyLabBatchState;
  createdAtMs: number;
  updatedAtMs: number;
  progress: {
    totalRuns: number;
    completedRuns: number;
  };
  runs: StrategyLabRunResult[];
  summary: StrategyLabBatchSummary;
  l2Files?: Record<string, string>;
  riskMode?: CounterfactualRiskMode;
  bypassReasons?: string[];
  continuousBankroll?: boolean;
  /** Optional callback invoked after each run completes (before evidence is stripped). */
  onRunComplete?: (run: StrategyLabRunResult) => void;
  quiet?: boolean;
  error?: string;
};

export type StrategyLabBatchProgress = {
  id: string;
  state: StrategyLabBatchState;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  canceledRuns: number;
  currentSlug: string | null;
  updatedAtMs: number;
};

const CALIBRATION_RELEVANT_TELEMETRY = new Set<TelemetryEvent["type"]>([
  "DECISION_FEATURE_SNAPSHOT",
  "ORDER_INTENT",
  "RISK_DECISION",
  "ORDER_LIFECYCLE",
  "ROUND_RESOLUTION",
  "ROUND_PNL",
  "SESSION_PNL",
]);

class CalibrationTelemetrySink implements TelemetrySink {
  events: TelemetryEvent[] = [];

  push(event: TelemetryEvent): void {
    if (CALIBRATION_RELEVANT_TELEMETRY.has(event.type)) {
      this.events.push(event);
    }
  }
}

const EMPTY_COUNTS = {
  intents: 0,
  allowed: 0,
  blocked: 0,
  fills: 0,
  problems: 0,
  settlements: 0,
};

const EMPTY_EXECUTION_SUMMARY: ExecutionQualitySummary = {
  fillRate: null,
  cancelRate: null,
  takerFeeSpend: 0,
  makerRebateEstimate: 0,
  grossEdgeCapture: null,
  turnover: 0,
  maxDrawdown: 0,
  markouts: {
    oneSecond: null,
    fiveSecond: null,
    thirtySecond: null,
    settlement: null,
    samples: 0,
    unavailableCount: 0,
    unavailableReasons: {},
  },
  conservativeFill: {
    conservativeFillEvidenceAvailable: false,
    conservativeFillEvidenceSource: "unavailable",
    conservativeFillVerdictCounts: {
      no_fill: 0,
      touch_only: 0,
      probable_fill: 0,
      trade_through_fill: 0,
      unknown_insufficient_data: 0,
    },
    conservativeFillUnavailableReasons: {},
    conservativeMarkout1sAvg: null,
    conservativeMarkout5sAvg: null,
    conservativeMarkout30sAvg: null,
    conservativeAdverseSelectionRate: null,
    usableEvidenceCount: 0,
    evaluatedFillCount: 0,
    eligibleFillCount: 0,
    confirmedFillCount: 0,
    rejectedFillCount: 0,
    evidence: [],
  },
};

function emptyExecutionSummary(): ExecutionQualitySummary {
  return {
    ...EMPTY_EXECUTION_SUMMARY,
    markouts: { ...EMPTY_EXECUTION_SUMMARY.markouts },
    conservativeFill: {
      ...EMPTY_EXECUTION_SUMMARY.conservativeFill,
      conservativeFillVerdictCounts: { ...EMPTY_EXECUTION_SUMMARY.conservativeFill.conservativeFillVerdictCounts },
      conservativeFillUnavailableReasons: { ...EMPTY_EXECUTION_SUMMARY.conservativeFill.conservativeFillUnavailableReasons },
    },
  };
}

const MAX_BATCH_RUNS = 2000;

function emptySummary(totalRuns: number): StrategyLabBatchSummary {
  return {
    totalRuns,
    completed: 0,
    failed: 0,
    canceled: 0,
    winRate: null,
    totalPnl: 0,
    avgPnl: null,
    bestPnl: null,
    worstPnl: null,
    conservativeAdjustedTotalPnl: 0,
    conservativeAdjustedAvgPnl: null,
    conservativeAdjustedBestPnl: null,
    conservativeAdjustedWorstPnl: null,
    blocked: 0,
    problems: 0,
    byStrategy: [],
    recommendation: null,
  };
}

export function deriveResultFromEvents(
  base: StrategyLabRunResult,
  events: TelemetryEvent[],
  replayReferences: ReferencePricePoint[] = [],
  l2Events: any[] | L2EventIndex = [],
): StrategyLabRunResult {
  const result: StrategyLabRunResult = {
    ...base,
    counts: { ...EMPTY_COUNTS },
    status: "completed",
    pnl: 0,
    verdict: "flat",
    brierScore: null,
    logLoss: null,
    execution: emptyExecutionSummary(),
  };

  const forecasts: number[] = [];
  const filledSides: Array<"UP" | "DOWN"> = [];
  const fillsForMarkout: FillForMarkout[] = [];
  let placedOrders = 0;
  let terminalCancels = 0;
  let turnover = 0;
  let runningLowPnl = 0;
  let settlementTsMs: number | null = null;

  // Track intent data for conservative fill scoring
  const intentsById = new Map<string, { tokenId: string; createdAtMs: number; decisionFeature?: DecisionFeatureSnapshot }>();
  const intentsBySlug = new Map<string, { tokenId: string; createdAtMs: number; decisionFeature?: DecisionFeatureSnapshot }[]>();
  const decisionFeaturesByIntentId = new Map<string, DecisionFeatureSnapshot>();
  const decisionFeaturesByOrderId = new Map<string, DecisionFeatureSnapshot>();
  const fillEvents: Array<{
    orderId: string | null;
    intentId: string | null;
    slug: string;
    action: "buy" | "sell";
    side: "UP" | "DOWN";
    price: number;
    shares: number;
    tsMs: number;
  }> = [];

  for (const event of events) {
    switch (event.type) {
      case "SYSTEM_BOOT":
        break;
      case "DECISION_FEATURE_SNAPSHOT":
        if (event.payload.intent?.id) {
          const existing = decisionFeaturesByIntentId.get(event.payload.intent.id);
          if (!existing || existing.event !== "consider" || event.payload.event === "consider") {
            decisionFeaturesByIntentId.set(event.payload.intent.id, event.payload);
          }
        }
        if (event.payload.outcome.orderId) {
          decisionFeaturesByOrderId.set(event.payload.outcome.orderId, event.payload);
        }
        if (event.payload.event === "consider" && event.payload.quant.probabilityUp !== null) {
          forecasts.push(event.payload.quant.probabilityUp);
        }
        break;
      case "ORDER_INTENT":
        result.slug = event.payload.slug;
        result.counts.intents += 1;
        if (event.payload.intent) {
          const intentData = {
            tokenId: (event.payload.intent as any).tokenId,
            createdAtMs: (event.payload.intent as any).createdAtMs,
            decisionFeature: event.payload.intent.id ? decisionFeaturesByIntentId.get(event.payload.intent.id) : undefined,
          };
          if (event.payload.intent.id) {
            intentsById.set(event.payload.intent.id, intentData);
          }
          const list = intentsBySlug.get(event.payload.slug) ?? [];
          list.push(intentData);
          intentsBySlug.set(event.payload.slug, list);
        }
        break;
      case "RISK_DECISION":
        result.slug = event.payload.slug;
        if (event.payload.approved) result.counts.allowed += 1;
        else result.counts.blocked += 1;
        break;
      case "ORDER_LIFECYCLE":
        result.slug = event.payload.slug;
        if (event.payload.status === "placed") placedOrders += 1;
        if (event.payload.status === "filled" || event.payload.status === "partial_filled") {
          result.counts.fills += 1;
          filledSides.push(event.payload.side);
          turnover += event.payload.price * event.payload.shares;
          fillsForMarkout.push({
            orderId: event.payload.orderId ?? event.payload.intentId ?? `${event.payload.slug}-${event.ts}-${result.counts.fills}`,
            tsMs: event.ts,
            side: event.payload.side,
            action: event.payload.action,
            price: event.payload.price,
          });

          fillEvents.push({
            orderId: event.payload.orderId ?? null,
            intentId: event.payload.intentId ?? null,
            slug: event.payload.slug,
            action: event.payload.action,
            side: event.payload.side,
            price: event.payload.price,
            shares: event.payload.shares,
            tsMs: event.ts,
          });
        }
        if (event.payload.status === "failed" || event.payload.status === "canceled" || event.payload.status === "expired") {
          result.counts.problems += 1;
        }
        if (event.payload.status === "canceled" || event.payload.status === "expired") terminalCancels += 1;
        break;
      case "ROUND_RESOLUTION":
        result.slug = event.payload.slug;
        result.direction = event.payload.direction;
        result.openPrice = event.payload.openPrice;
        result.closePrice = event.payload.closePrice;
        settlementTsMs = event.ts;
        break;
      case "ROUND_PNL":
        result.slug = event.payload.slug;
        result.pnl = event.payload.pnl;
        runningLowPnl = Math.min(runningLowPnl, event.payload.pnl);
        result.counts.settlements += 1;
        break;
      case "SESSION_PNL":
        result.pnl = event.payload.pnl;
        break;
    }
  }

  // Calculate probabilistic scoring (Brier/LogLoss) if we have forecasts and an outcome
  if (forecasts.length > 0 && result.direction !== null) {
    const outcome = result.direction === "UP" ? 1 : 0;
    const outcomes = new Array(forecasts.length).fill(outcome);
    result.brierScore = calculateBrierScore(forecasts, outcomes);
    result.logLoss = calculateLogLoss(forecasts, outcomes);
  }

  const pnl = result.pnl ?? 0;
  const referencesWithSettlement =
    result.direction !== null && settlementTsMs !== null
      ? appendSettlementReference(replayReferences, { tsMs: settlementTsMs, direction: result.direction })
      : replayReferences;
  const markoutResults = fillsForMarkout.flatMap((fill) =>
    calculateMarkouts(fill, referencesWithSettlement, { skipSort: true }),
  );
  const markoutSummary: MarkoutSummary = summarizeMarkouts(markoutResults);

  // --- Rigorous Conservative Fill Scoring ---
  const scorer = new ConservativeFillScorer();
  const cFill = result.execution.conservativeFill;

  const l2Available = Array.isArray(l2Events) ? l2Events.length > 0 : l2Events.totalEvents > 0;

  if (l2Available) {
    cFill.conservativeFillEvidenceAvailable = true;
    cFill.conservativeFillEvidenceSource = "raw_l2_event_store";
  } else {
    cFill.conservativeFillEvidenceAvailable = false;
    cFill.conservativeFillEvidenceSource = "unavailable";
    cFill.conservativeFillWarning = "raw_l2_events_missing";
    cFill.conservativeFillUnavailableReasons.missing_raw_l2_events = fillEvents.length > 0 ? fillEvents.length : 1;
  }

  cFill.eligibleFillCount = fillEvents.length;

  if (cFill.conservativeFillEvidenceAvailable) {
    const conservativeMarkout1s: number[] = [];
    const conservativeMarkout5s: number[] = [];
    const conservativeMarkout30s: number[] = [];
    const scorerAdverse: boolean[] = [];

    const sortedL2 = Array.isArray(l2Events)
      ? [...l2Events].sort(l2EventTimeComparator)
      : l2Events;

    if (fillEvents.length === 0) {
      cFill.conservativeFillWarning = "no_eligible_fills";
    }

    for (const fill of fillEvents) {
      let intent: { tokenId: string; createdAtMs: number; decisionFeature?: DecisionFeatureSnapshot } | undefined;

      // 1. If fill.intentId exists: use intentsById.get(fill.intentId)
      if (fill.intentId) {
        intent = intentsById.get(fill.intentId);
        if (!intent) {
          cFill.conservativeFillUnavailableReasons.unmatched_intent_id = (cFill.conservativeFillUnavailableReasons.unmatched_intent_id ?? 0) + 1;
          continue;
        }
      } else {
        // 2. If no intent mapping via intentId: fallback to slug only if exactly one intent exists for that slug.
        const slugIntents = intentsBySlug.get(fill.slug) ?? [];
        if (slugIntents.length === 1) {
          intent = slugIntents[0];
        } else if (slugIntents.length > 1) {
          // 3. If multiple intents exist for the same slug and no unambiguous ID link exists: do not score it.
          cFill.conservativeFillUnavailableReasons.ambiguous_intent_mapping = (cFill.conservativeFillUnavailableReasons.ambiguous_intent_mapping ?? 0) + 1;
          continue;
        } else {
          // 4. If no intent exists: increment missing_intent_mapping
          cFill.conservativeFillUnavailableReasons.missing_intent_mapping = (cFill.conservativeFillUnavailableReasons.missing_intent_mapping ?? 0) + 1;
          continue;
        }
      }

      if (!intent?.tokenId) {
        cFill.conservativeFillUnavailableReasons.missing_token_id = (cFill.conservativeFillUnavailableReasons.missing_token_id ?? 0) + 1;
        continue;
      }
      if (intent.createdAtMs === undefined || intent.createdAtMs === null) {
        cFill.conservativeFillUnavailableReasons.missing_order_placement_time = (cFill.conservativeFillUnavailableReasons.missing_order_placement_time ?? 0) + 1;
        continue;
      }

      cFill.evaluatedFillCount++;

      const scorerEvents = Array.isArray(sortedL2)
        ? sortedL2
        : getIndexedL2Window(sortedL2, intent.tokenId, intent.createdAtMs);

      const scorerResult = scorer.evaluate({
        orderId: fill.orderId ?? fill.intentId ?? "unknown",
        tokenId: intent.tokenId,
        action: fill.action,
        side: fill.side,
        price: fill.price,
        shares: fill.shares,
        placedTsMs: intent.createdAtMs,
        skipSort: true,
      }, scorerEvents);

      if (!cFill.evidence) cFill.evidence = [];
      cFill.evidence.push({
        orderId: fill.orderId ?? fill.intentId ?? "unknown",
        tokenId: intent.tokenId,
        action: fill.action,
        side: fill.side,
        price: fill.price,
        shares: fill.shares,
        placedTsMs: intent.createdAtMs,
        fillTsMs: fill.tsMs,
        verdict: scorerResult.verdict,
        markouts: scorerResult.markouts,
        adverseSelection: scorerResult.adverseSelection,
        decisionFeature: intent.decisionFeature
          ?? (fill.intentId ? decisionFeaturesByIntentId.get(fill.intentId) : undefined)
          ?? (fill.orderId ? decisionFeaturesByOrderId.get(fill.orderId) : undefined),
      });

      cFill.conservativeFillVerdictCounts[scorerResult.verdict] = (cFill.conservativeFillVerdictCounts[scorerResult.verdict] ?? 0) + 1;
      if (scorerResult.verdict === "probable_fill" || scorerResult.verdict === "trade_through_fill") {
        cFill.confirmedFillCount++;
      } else if (scorerResult.verdict === "no_fill" || scorerResult.verdict === "touch_only") {
        cFill.rejectedFillCount++;
      }
      
      if (scorerResult.verdict !== "unknown_insufficient_data") {
        cFill.usableEvidenceCount++;
      }

      if (scorerResult.markouts["1s"] !== null) conservativeMarkout1s.push(scorerResult.markouts["1s"]);
      if (scorerResult.markouts["5s"] !== null) conservativeMarkout5s.push(scorerResult.markouts["5s"]);
      if (scorerResult.markouts["30s"] !== null) conservativeMarkout30s.push(scorerResult.markouts["30s"]);
      if (scorerResult.adverseSelection !== null) scorerAdverse.push(scorerResult.adverseSelection);
    }

    if (conservativeMarkout1s.length > 0) {
      cFill.conservativeMarkout1sAvg = average(conservativeMarkout1s);
    }
    if (conservativeMarkout5s.length > 0) {
      cFill.conservativeMarkout5sAvg = average(conservativeMarkout5s);
    }
    if (conservativeMarkout30s.length > 0) {
      cFill.conservativeMarkout30sAvg = average(conservativeMarkout30s);
    }
    if (scorerAdverse.length > 0) {
      cFill.conservativeAdverseSelectionRate = scorerAdverse.filter(v => v).length / scorerAdverse.length;
    }
  }

  const wasPredictiveWin = result.direction !== null && filledSides.some(side => side === result.direction);
  const hadWrongDirectionalFill = result.direction !== null && filledSides.some(side => side !== result.direction);
  const positivePnlUnconfirmed =
    cFill.conservativeFillEvidenceAvailable &&
    cFill.eligibleFillCount > 0 &&
    cFill.confirmedFillCount === 0 &&
    cFill.rejectedFillCount > 0 &&
    pnl > 0;
  if (positivePnlUnconfirmed) {
    cFill.conservativeFillWarning = "optimistic_pnl_rejected_by_l2";
  }

  result.execution = {
    fillRate: result.counts.intents > 0 ? result.counts.fills / result.counts.intents : null,
    cancelRate: placedOrders > 0 ? terminalCancels / placedOrders : null,
    takerFeeSpend: 0,
    makerRebateEstimate: 0,
    grossEdgeCapture: turnover > 0 ? parseFloat((pnl / turnover).toFixed(6)) : null,
    turnover: parseFloat(turnover.toFixed(4)),
    maxDrawdown: parseFloat(Math.abs(runningLowPnl).toFixed(4)),
    markouts: {
      oneSecond: markoutSummary.oneSecond,
      fiveSecond: markoutSummary.fiveSecond,
      thirtySecond: markoutSummary.thirtySecond,
      settlement: markoutSummary.settlement,
      samples: markoutSummary.samples,
      unavailableCount: markoutSummary.unavailableCount,
      unavailableReasons: markoutSummary.unavailableReasons,
    },
    conservativeFill: cFill,
  };

  if (result.counts.blocked > 0 && result.counts.fills === 0) result.verdict = "blocked";
  else if (result.counts.intents === 0 && result.counts.fills === 0) result.verdict = "no_trade";
  else if (pnl > 0) result.verdict = !positivePnlUnconfirmed && wasPredictiveWin && !hadWrongDirectionalFill ? "win" : "flat"; // Rebate-only, mixed-side, or L2-rejected wins are not counted as directional skill.
  else if (pnl < 0) result.verdict = "loss";
  else result.verdict = "flat";
  result.pnl = parseFloat(pnl.toFixed(4));
  return result;
}

function recomputeSummary(batch: StrategyLabBatch): StrategyLabBatchSummary {
  const completedRuns = batch.runs.filter(run => run.status === "completed");
  const pnlRuns = completedRuns.filter(run => typeof run.pnl === "number") as Array<StrategyLabRunResult & { pnl: number }>;
  const wins = completedRuns.filter(run => run.verdict === "win").length;
  const totalPnl = parseFloat(pnlRuns.reduce((sum, run) => sum + run.pnl, 0).toFixed(4));
  const adjustedPnls = pnlRuns.map(conservativeAdjustedPnl);
  const adjustedTotalPnl = parseFloat(adjustedPnls.reduce((sum, pnl) => sum + pnl, 0).toFixed(4));
  const byStrategy = summarizeByStrategy(batch.runs);

  return {
    totalRuns: batch.runs.length,
    completed: completedRuns.length,
    failed: batch.runs.filter(run => run.status === "failed").length,
    canceled: batch.runs.filter(run => run.status === "canceled").length,
    winRate: completedRuns.length > 0 ? wins / completedRuns.length : null,
    totalPnl,
    avgPnl: pnlRuns.length > 0 ? parseFloat((totalPnl / pnlRuns.length).toFixed(4)) : null,
    bestPnl: pnlRuns.length > 0 ? Math.max(...pnlRuns.map(run => run.pnl)) : null,
    worstPnl: pnlRuns.length > 0 ? Math.min(...pnlRuns.map(run => run.pnl)) : null,
    conservativeAdjustedTotalPnl: adjustedTotalPnl,
    conservativeAdjustedAvgPnl: adjustedPnls.length > 0 ? parseFloat((adjustedTotalPnl / adjustedPnls.length).toFixed(4)) : null,
    conservativeAdjustedBestPnl: adjustedPnls.length > 0 ? Math.max(...adjustedPnls) : null,
    conservativeAdjustedWorstPnl: adjustedPnls.length > 0 ? Math.min(...adjustedPnls) : null,
    blocked: batch.runs.reduce((sum, run) => sum + run.counts.blocked, 0),
    problems: batch.runs.reduce((sum, run) => sum + run.counts.problems, 0),
    byStrategy,
    recommendation: recommendStrategy(byStrategy),
  };
}

export const recomputeSummaryForTest = recomputeSummary;

function conservativeAdjustedPnl(run: StrategyLabRunResult & { pnl: number }): number {
  const cFill = run.execution.conservativeFill;
  const rejectedByL2 =
    cFill.conservativeFillEvidenceAvailable &&
    cFill.eligibleFillCount > 0 &&
    cFill.confirmedFillCount === 0 &&
    cFill.rejectedFillCount > 0 &&
    run.pnl > 0;
  return rejectedByL2 ? 0 : run.pnl;
}

function summarizeByStrategy(runs: StrategyLabRunResult[]): StrategyLabVariantSummary[] {
  const grouped = new Map<string, StrategyLabRunResult[]>();
  for (const run of runs) {
    const current = grouped.get(run.strategy) ?? [];
    current.push(run);
    grouped.set(run.strategy, current);
  }

  return [...grouped.entries()]
    .map(([strategy, items]) => {
      const completed = items.filter(run => run.status === "completed");
      const pnlRuns = completed.filter(run => typeof run.pnl === "number") as Array<StrategyLabRunResult & { pnl: number }>;
      const wins = completed.filter(run => run.verdict === "win").length;
      const losses = completed.filter(run => run.verdict === "loss").length;
      const noTrades = completed.filter(run => run.verdict === "no_trade").length;
      const blockedVerdicts = completed.filter(run => run.verdict === "blocked").length;
      const tradeCount = completed.filter(run => run.counts.fills > 0 || run.counts.intents > 0).length;
      const totalPnl = parseFloat(pnlRuns.reduce((sum, run) => sum + run.pnl, 0).toFixed(4));
      const adjustedPnls = pnlRuns.map(conservativeAdjustedPnl);
      const adjustedTotalPnl = parseFloat(adjustedPnls.reduce((sum, pnl) => sum + pnl, 0).toFixed(4));
      const failed = items.filter(run => run.status === "failed").length;
      const canceled = items.filter(run => run.status === "canceled").length;
      const blocked = items.reduce((sum, run) => sum + run.counts.blocked, 0);
      const problems = items.reduce((sum, run) => sum + run.counts.problems, 0);
      const brierRuns = completed.filter(run => run.brierScore !== null);
      const avgBrier = brierRuns.length > 0 ? brierRuns.reduce((sum, run) => sum + run.brierScore!, 0) / brierRuns.length : null;
      const avgLogLoss = brierRuns.length > 0 ? brierRuns.reduce((sum, run) => sum + run.logLoss!, 0) / brierRuns.length : null;
      const avgFillRate = average(completed.map(run => run.execution.fillRate));
      const avgCancelRate = average(completed.map(run => run.execution.cancelRate));
      const avgMarkout1s = average(completed.map(run => run.execution.markouts.oneSecond));
      const avgMarkout5s = average(completed.map(run => run.execution.markouts.fiveSecond));
      const avgMarkout30s = average(completed.map(run => run.execution.markouts.thirtySecond));
      const avgSettlementMarkout = average(completed.map(run => run.execution.markouts.settlement));
      const markoutSampleCount = completed.reduce((sum, run) => sum + run.execution.markouts.samples, 0);
      const markoutUnavailableCount = completed.reduce((sum, run) => sum + run.execution.markouts.unavailableCount, 0);
      const avgTurnover = average(completed.map(run => run.execution.turnover));

      const noFillCount = items.reduce((sum, run) => sum + (run.execution.conservativeFill.conservativeFillVerdictCounts.no_fill ?? 0), 0);
      const touchOnlyCount = items.reduce((sum, run) => sum + (run.execution.conservativeFill.conservativeFillVerdictCounts.touch_only ?? 0), 0);
      const probableFillCount = items.reduce((sum, run) => sum + (run.execution.conservativeFill.conservativeFillVerdictCounts.probable_fill ?? 0), 0);
      const tradeThroughFillCount = items.reduce((sum, run) => sum + (run.execution.conservativeFill.conservativeFillVerdictCounts.trade_through_fill ?? 0), 0);
      const unknownInsufficientDataCount = items.reduce((sum, run) => sum + (run.execution.conservativeFill.conservativeFillVerdictCounts.unknown_insufficient_data ?? 0), 0);
      const totalEligibleFills = items.reduce((sum, run) => sum + run.execution.conservativeFill.eligibleFillCount, 0);
      const totalEvaluatedFills = items.reduce((sum, run) => sum + run.execution.conservativeFill.evaluatedFillCount, 0);
      const totalUsableFills = items.reduce((sum, run) => sum + run.execution.conservativeFill.usableEvidenceCount, 0);
      const totalConfirmedFills = items.reduce((sum, run) => sum + run.execution.conservativeFill.confirmedFillCount, 0);
      const totalRejectedFills = items.reduce((sum, run) => sum + run.execution.conservativeFill.rejectedFillCount, 0);
      const usableEvidenceRate = totalEvaluatedFills > 0 ? totalUsableFills / totalEvaluatedFills : null;
      const avgCmarkout1s = average(completed.map(run => run.execution.conservativeFill.conservativeMarkout1sAvg));
      const avgCmarkout5s = average(completed.map(run => run.execution.conservativeFill.conservativeMarkout5sAvg));
      const avgCmarkout30s = average(completed.map(run => run.execution.conservativeFill.conservativeMarkout30sAvg));
      const adverseSelectionRate = average(completed.map(run => run.execution.conservativeFill.conservativeAdverseSelectionRate));

      const tradeRate = completed.length > 0 ? tradeCount / completed.length : null;
      const score = scoreStrategy({
        totalPnl: adjustedTotalPnl,
        completed: completed.length,
        failed,
        canceled,
        wins,
        losses,
        noTrades,
        blocked,
        problems,
        worstPnl: adjustedPnls.length > 0 ? Math.min(...adjustedPnls) : null,
        tradeRate,
        brierScore: avgBrier,
      });

      return {
        strategy,
        baseStrategy: items[0]?.baseStrategy ?? strategy,
        label: items[0]?.variantLabel ?? strategy,
        paperEligible: items.some(run => run.paperEligible),
        runs: items.length,
        completed: completed.length,
        failed,
        canceled,
        wins,
        losses,
        noTrades,
        blockedVerdicts,
        tradeCount,
        winRate: completed.length > 0 ? wins / completed.length : null,
        tradeRate,
        totalPnl,
        avgPnl: pnlRuns.length > 0 ? parseFloat((totalPnl / pnlRuns.length).toFixed(4)) : null,
        bestPnl: pnlRuns.length > 0 ? Math.max(...pnlRuns.map(run => run.pnl)) : null,
        worstPnl: pnlRuns.length > 0 ? Math.min(...pnlRuns.map(run => run.pnl)) : null,
        conservativeAdjustedTotalPnl: adjustedTotalPnl,
        conservativeAdjustedAvgPnl: adjustedPnls.length > 0 ? parseFloat((adjustedTotalPnl / adjustedPnls.length).toFixed(4)) : null,
        conservativeAdjustedBestPnl: adjustedPnls.length > 0 ? Math.max(...adjustedPnls) : null,
        conservativeAdjustedWorstPnl: adjustedPnls.length > 0 ? Math.min(...adjustedPnls) : null,
        blocked,
        problems,
        brierScore: avgBrier !== null ? parseFloat(avgBrier.toFixed(6)) : null,
        logLoss: avgLogLoss !== null ? parseFloat(avgLogLoss.toFixed(6)) : null,
        avgFillRate,
        avgCancelRate,
        avgMarkout1s,
        avgMarkout5s,
        avgMarkout30s,
        avgSettlementMarkout,
        markoutSampleCount,
        markoutUnavailableCount,
        avgTurnover,
        conservativeFill: {
          noFillCount,
          touchOnlyCount,
          probableFillCount,
          tradeThroughFillCount,
          confirmedFillCount: totalConfirmedFills,
          rejectedFillCount: totalRejectedFills,
          unknownInsufficientDataCount,
          usableEvidenceRate,
          usableEvidenceCount: totalUsableFills,
          evaluatedFillCount: totalEvaluatedFills,
          eligibleFillCount: totalEligibleFills,
          avgMarkout1s: avgCmarkout1s,
          avgMarkout5s: avgCmarkout5s,
          avgMarkout30s: avgCmarkout30s,
          adverseSelectionRate,
        },
        score,
      };
    })
    .sort((a, b) => b.score - a.score || b.totalPnl - a.totalPnl || a.strategy.localeCompare(b.strategy));
}

function average(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return parseFloat((finite.reduce((sum, value) => sum + value, 0) / finite.length).toFixed(6));
}

function scoreStrategy(input: {
  totalPnl: number;
  completed: number;
  failed: number;
  canceled: number;
  wins: number;
  losses: number;
  noTrades: number;
  blocked: number;
  problems: number;
  worstPnl: number | null;
  tradeRate: number | null;
  brierScore: number | null;
}): number {
  const winRate = input.completed > 0 ? input.wins / input.completed : 0;
  const tradeRate = input.tradeRate ?? 0;
  const worstPenalty = input.worstPnl != null && input.worstPnl < 0 ? Math.abs(input.worstPnl) * 1.5 : 0;
  
  // Probabilistic calibration score:
  // 0.25 is no-skill (predicting 0.5 for all). 
  // We reward strategies that are better than 0.25 and penalize those worse.
  const brierScore = input.brierScore ?? 0.25;
  const calibrationBonus = (0.25 - brierScore) * 60; // Max bonus +15 at Brier=0

  const score =
    input.totalPnl * 10 +
    winRate * 8 +
    tradeRate * 3 +
    calibrationBonus -
    input.losses * 2 -
    input.noTrades * 0.4 -
    input.failed * 8 -
    input.canceled * 5 -
    input.blocked * 1.5 -
    input.problems * 2 -
    worstPenalty;
  return parseFloat(score.toFixed(4));
}

function recommendStrategy(summaries: StrategyLabVariantSummary[]): StrategyLabRecommendation {
  const viable = summaries.filter(summary => summary.completed > 0 && summary.failed === 0 && summary.canceled === 0);
  if (viable.length === 0) return null;

  const winner = viable[0]!;
  const readyForPaper =
    winner.paperEligible &&
    winner.conservativeAdjustedTotalPnl > 0 &&
    (winner.tradeRate ?? 0) >= 0.2 &&
    winner.problems === 0 &&
    winner.blocked === 0 &&
    (winner.conservativeAdjustedWorstPnl ?? 0) >= -2;

  const rationale = [
    `Ranked #1 by safety-weighted score (${winner.score.toFixed(2)}).`,
    `Conservative-adjusted PnL ${winner.conservativeAdjustedTotalPnl >= 0 ? "+" : ""}$${winner.conservativeAdjustedTotalPnl.toFixed(2)} (raw ${winner.totalPnl >= 0 ? "+" : ""}$${winner.totalPnl.toFixed(2)}) across ${winner.completed}/${winner.runs} completed runs.`,
    `Trade rate ${winner.tradeRate == null ? "---" : `${Math.round(winner.tradeRate * 100)}%`} with ${winner.problems} problems and ${winner.blocked} blocked decisions.`,
  ];

  if (!readyForPaper) {
    if (!winner.paperEligible) {
      rationale.push("Keep this variant in replay tuning because it is not marked paper-eligible.");
    } else {
      rationale.push("Keep in replay tuning before paper mode because the safety gate did not pass.");
    }
  } else {
    rationale.push("Eligible for a paper-mode smoke run under operator supervision.");
  }

  return {
    strategy: winner.strategy,
    label: winner.label,
    score: winner.score,
    readyForPaper,
    rationale,
  };
}

function cloneBatch(batch: StrategyLabBatch): StrategyLabBatch {
  // onRunComplete is a function — structuredClone can't handle it.
  // Strip before cloning, restore the reference after.
  const callback = (batch as any).onRunComplete;
  (batch as any).onRunComplete = undefined;
  const cloned = structuredClone(batch);
  (batch as any).onRunComplete = callback; // restore on original
  (cloned as any).onRunComplete = callback; // share reference on clone
  return cloned;
}

import { createReadStream } from "fs";
import * as readline from "readline";

export type L2EventIndex = {
  totalEvents: number;
  eventsByTokenId: Map<string, any[]>;
};

function l2EventTs(evt: any): number {
  return evt.processedTsMs ?? evt.receivedTsMs ?? 0;
}

function beginQuietReplayLogs(enabled: boolean): () => void {
  if (!enabled) return () => {};
  const previousConsoleLog = console.log;
  const previousMuted = log.muted;
  console.log = () => {};
  log.setMuted(true);
  return () => {
    console.log = previousConsoleLog;
    log.setMuted(previousMuted);
  };
}

function l2EventTimeComparator(a: any, b: any): number {
  return l2EventTs(a) - l2EventTs(b);
}

function l2EventTokenId(evt: any): string | null {
  const tokenId = evt?.payload?.tokenId;
  return typeof tokenId === "string" && tokenId.length > 0 ? tokenId : null;
}

export function buildL2EventIndex(events: any[]): L2EventIndex {
  const eventsByTokenId = new Map<string, any[]>();
  for (const evt of events) {
    const tokenId = l2EventTokenId(evt);
    if (!tokenId) continue;
    const list = eventsByTokenId.get(tokenId) ?? [];
    list.push(evt);
    eventsByTokenId.set(tokenId, list);
  }
  for (const list of eventsByTokenId.values()) {
    list.sort(l2EventTimeComparator);
  }
  return { totalEvents: events.length, eventsByTokenId };
}

export function getIndexedL2Window(index: L2EventIndex, tokenId: string, placedTsMs: number, maxWaitMs = Number.POSITIVE_INFINITY): any[] {
  const events = index.eventsByTokenId.get(tokenId) ?? [];
  if (events.length === 0) return [];

  let low = 0;
  let high = events.length - 1;
  let startIndex = events.length;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const evt = events[mid];
    const ts = evt ? l2EventTs(evt) : 0;
    if (ts < placedTsMs) {
      low = mid + 1;
    } else {
      startIndex = mid;
      high = mid - 1;
    }
  }

  if (!Number.isFinite(maxWaitMs)) return events.slice(startIndex);

  const endTs = placedTsMs + maxWaitMs;
  let endIndex = startIndex;
  while (endIndex < events.length && l2EventTs(events[endIndex]) <= endTs) {
    endIndex++;
  }
  return events.slice(startIndex, endIndex);
}

async function loadL2EventIndex(path: string): Promise<L2EventIndex> {
  try {
    const events: any[] = [];
    const rl = readline.createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        // We only need book and trade events for fill scoring
        if (evt.eventType === "market_book_snapshot" || 
            evt.eventType === "market_book_delta" || 
            evt.eventType === "market_trade") {
          events.push(evt);
        }
      } catch (e) {
        // Skip malformed lines
      }
    }
    events.sort(l2EventTimeComparator);
    return buildL2EventIndex(events);
  } catch (e) {
    console.error(`Failed to load L2 events from ${path}:`, e);
    return buildL2EventIndex([]);
  }
}

export class StrategyLabBatchManager {
  private batches = new Map<string, StrategyLabBatch>();
  private cancelRequested = new Set<string>();
  private currentBots = new Map<string, EarlyBird>();
  private l2EventIndexCache = new Map<string, Promise<L2EventIndex>>();

  listStrategies(): string[] {
    return [...new Set(listStrategyVariants().map(variant => variant.strategy))].sort();
  }

  listVariants(): StrategyVariant[] {
    return listStrategyVariants();
  }

  async createBatch(request: StrategyLabBatchRequest): Promise<StrategyLabBatch> {
    const selectedStrategies = [...new Set(request.variants ?? request.strategies ?? [])];
    const selectedFiles = [...new Set(request.files ?? [])];

    if (selectedStrategies.length === 0) throw new Error("At least one strategy variant is required");
    if (selectedFiles.length === 0) throw new Error("At least one replay fixture is required");

    const resolvedSelections = selectedStrategies.map(selection => {
      try {
        return resolveStrategySelection(selection);
      } catch {
        throw new Error(`Unknown strategy variant: ${selection}`);
      }
    });

    const totalRuns = resolvedSelections.length * selectedFiles.length;
    if (totalRuns > MAX_BATCH_RUNS) {
      throw new Error(`Strategy Lab batches are capped at ${MAX_BATCH_RUNS} runs; requested ${totalRuns}`);
    }

    const fixtureMetadata = await Promise.all(selectedFiles.map(file => validateReplayFixture(file)));
    const invalid = fixtureMetadata.find(meta => !meta.replayable);
    if (invalid) {
      throw new Error(`Replay fixture is not replayable: ${invalid.label}${invalid.reason ? ` (${invalid.reason})` : ""}`);
    }

    const runs: StrategyLabRunResult[] = [];
    for (const resolved of resolvedSelections) {
      for (const file of selectedFiles) {
        const fixture = fixtureMetadata.find(meta => meta.path === file);
        runs.push({
          id: crypto.randomUUID(),
          strategy: resolved.selection,
          baseStrategy: resolved.strategyName,
          variantLabel: resolved.variant.label,
          paperEligible: resolved.variant.paperEligible,
          file,
          slug: fixture?.slug ?? null,
          status: "queued",
          pnl: null,
          direction: null,
          openPrice: null,
          closePrice: null,
          counts: { ...EMPTY_COUNTS },
          verdict: null,
          brierScore: null,
          logLoss: null,
          execution: emptyExecutionSummary(),
        });
      }
    }

    const now = Date.now();
    const batch: StrategyLabBatch = {
      id: crypto.randomUUID(),
      state: "queued",
      createdAtMs: now,
      updatedAtMs: now,
      progress: { totalRuns, completedRuns: 0 },
      runs,
      summary: emptySummary(totalRuns),
      l2Files: request.l2Files,
      riskMode: request.riskMode,
      bypassReasons: request.bypassReasons,
      continuousBankroll: request.continuousBankroll,
      onRunComplete: request.onRunComplete,
      quiet: request.quiet,
    } as any;
    this.batches.set(batch.id, batch);

    setTimeout(() => {
      void this.runBatch(batch.id);
    }, 0);

    return cloneBatch(batch);
  }

  getBatch(batchId: string): StrategyLabBatch | null {
    const batch = this.batches.get(batchId);
    return batch ? cloneBatch(batch) : null;
  }

  getBatchProgress(batchId: string): StrategyLabBatchProgress | null {
    const batch = this.batches.get(batchId);
    if (!batch) return null;
    const failedRuns = batch.runs.filter((run) => run.status === "failed").length;
    const canceledRuns = batch.runs.filter((run) => run.status === "canceled").length;
    const currentRun = batch.runs.find((run) => run.status === "running") ?? null;
    return {
      id: batch.id,
      state: batch.state,
      totalRuns: batch.progress.totalRuns,
      completedRuns: batch.progress.completedRuns,
      failedRuns,
      canceledRuns,
      currentSlug: currentRun?.slug ?? null,
      updatedAtMs: batch.updatedAtMs,
    };
  }

  cancelBatch(batchId: string): StrategyLabBatch | null {
    const batch = this.batches.get(batchId);
    if (!batch) return null;

    this.cancelRequested.add(batchId);
    this.currentBots.get(batchId)?.startShutdown("Strategy Lab batch canceled.");
    for (const run of batch.runs) {
      if (run.status === "queued" || run.status === "running") {
        run.status = "canceled";
        run.verdict = "failed";
        run.error = "Canceled";
      }
    }
    batch.state = "canceled";
    batch.updatedAtMs = Date.now();
    batch.progress.completedRuns = batch.runs.filter(run => run.status !== "queued" && run.status !== "running").length;
    batch.summary = recomputeSummary(batch);
    return cloneBatch(batch);
  }

  private loadL2EventIndex(path: string): Promise<L2EventIndex> {
    const existing = this.l2EventIndexCache.get(path);
    if (existing) return existing;
    const pending = loadL2EventIndex(path);
    this.l2EventIndexCache.set(path, pending);
    return pending;
  }

  private async runBatch(batchId: string): Promise<void> {
    const batch = this.batches.get(batchId) as any;
    if (!batch || batch.state === "canceled") return;

    batch.state = "running";
    batch.updatedAtMs = Date.now();

    const variantBalances = new Map<string, number>();

    for (const run of batch.runs) {
      if (this.cancelRequested.has(batchId) || (batch.state as StrategyLabBatchState) === "canceled") break;
      if (run.status !== "queued") continue;

      run.status = "running";
      batch.updatedAtMs = Date.now();
      const restoreReplayLogs = beginQuietReplayLogs(batch.quiet === true);

      try {
        const clock = new VirtualClock();
        const sink = new CalibrationTelemetrySink();
        const l2File = batch.l2Files?.[run.file];
        const tokenMapping = l2File 
          ? await extractClobTokenIdsFromRawL2(l2File)
          : { status: "unavailable" } as const;
        
        // Counterfactual runs are never paper eligible
        const useRiskMode = batch.riskMode ?? "normal";
        const isCounterfactual = useRiskMode !== "normal";
        if (isCounterfactual) {
          run.paperEligible = false;
        }

        let initialBalance = parseFloat(process.env.WALLET_BALANCE ?? "50");
        if (batch.continuousBankroll) {
          initialBalance = variantBalances.get(run.variantLabel) ?? initialBalance;
        }

        const bot = new EarlyBird(run.strategy, 1, false, 1, false, run.file, {
          clock,
          persistState: false,
          telemetry: sink,
          marketLogMode: "disabled",
          replayVenueMetadata: tokenMapping?.status === "ok"
            ? { clobTokenIds: tokenMapping.tokenIds }
            : undefined,
          conservativeFill: true,
          riskMode: useRiskMode,
          bypassRiskReasons: batch.bypassReasons,
          initialBalance,
        });
        this.currentBots.set(batchId, bot);
        const reader = bot.replayReader;
        if (!reader) throw new Error("Replay reader not initialized");
        const replayReferences: ReferencePricePoint[] = [];
        reader.subscribe((evt) => {
          if (evt.type === "orderbook_snapshot") {
            const getPrice = (levels: any) => Array.isArray(levels) && Array.isArray(levels[0]) && typeof levels[0][0] === "number" ? levels[0][0] : null;
            replayReferences.push({
              tsMs: evt.ts,
              upBid: getPrice(evt.up?.bids),
              upAsk: getPrice(evt.up?.asks),
              downBid: getPrice(evt.down?.bids),
              downAsk: getPrice(evt.down?.asks),
            });
          }
        });

        const runner = new ReplayRunner(reader, bot, clock, sink);
        await runner.run();

        // Yield to microtasks to ensure all telemetry from async placements is flushed
        await new Promise(resolve => setTimeout(resolve, 0));

        if ((run.status as StrategyLabRunStatus) !== "canceled") {
          const l2Events = l2File ? await this.loadL2EventIndex(l2File) : buildL2EventIndex([]);
          Object.assign(run, deriveResultFromEvents(run, sink.events, replayReferences, l2Events));
          if (l2File && tokenMapping?.status === "unavailable") {
            const cFill = run.execution.conservativeFill;
            const mapping = tokenMapping as { status: "unavailable"; reason: "token_mapping_missing" | "token_mapping_ambiguous" };
            if (cFill.eligibleFillCount > 0) {
              cFill.conservativeFillWarning = mapping.reason;
              cFill.conservativeFillUnavailableReasons[mapping.reason] =
                (cFill.conservativeFillUnavailableReasons[mapping.reason] ?? 0) +
                cFill.eligibleFillCount;
            }
          }
          // Fire the per-run callback before evidence is stripped
          if (batch.onRunComplete) {
            batch.onRunComplete(run);
          }
          if (batch.continuousBankroll && run.pnl !== null) {
            variantBalances.set(run.variantLabel, initialBalance + run.pnl);
          }
        }
      } catch (error) {
        if ((run.status as StrategyLabRunStatus) !== "canceled") {
          run.status = "failed";
          run.verdict = "failed";
          run.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        restoreReplayLogs();
        this.currentBots.delete(batchId);
        batch.progress.completedRuns = batch.runs.filter((item: StrategyLabRunResult) => item.status !== "queued" && item.status !== "running").length;
        if (!batch.onRunComplete) {
          batch.summary = recomputeSummary(batch);
        }
        batch.updatedAtMs = Date.now();
        // Strip heavy evidence data from completed runs to free memory.
        // Only strip when onRunComplete is set — the caller has already
        // extracted the data incrementally. Without it, the old pipeline
        // needs evidence preserved for batch-level extraction at the end.
        if (batch.onRunComplete && run.status === "completed" && run.execution?.conservativeFill?.evidence) {
          run.execution.conservativeFill.evidence = [];
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    if ((batch.state as StrategyLabBatchState) !== "canceled") {
      batch.state = batch.runs.some((run: StrategyLabRunResult) => run.status === "failed") ? "failed" : "completed";
      batch.progress.completedRuns = batch.runs.length;
      batch.summary = recomputeSummary(batch);
      batch.updatedAtMs = Date.now();
    }
  }
}

