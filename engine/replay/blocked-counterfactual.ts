import { type ProfitEventEnvelope, type MarketBookPayload, type StrategyPayload, type SettlementPayload } from "../event-store/events.ts";
import { ConservativeFillScorer, type FillScoreResult, type FillScoreVerdict, type ScoreFillOptions } from "./fill-scoring.ts";
import { calculateMarkouts, type ReferencePricePoint, type MarkoutResult } from "./markout.ts";

export type BlockedCounterfactualVerdict =
  | "good_block"
  | "bad_block"
  | "blocked_but_no_fill"
  | "unrealistic_duplicate"
  | "inconclusive";

export type BlockedFillEvidence =
  | "no_fill"
  | "touch_only"
  | "trade_through_fill"
  | "probable_fill"
  | "unknown_insufficient_data";

export type BlockedCounterfactualRecord = {
  schemaVersion: 1;
  diagnosticOnly: true;
  riskMode: "normal-audit" | "permissive-counterfactual" | "selective-counterfactual";

  strategy: string | null;
  variant: string | null;
  slug: string;
  timestampMs: number;
  intentId: string | null;

  side: "UP" | "DOWN" | null;
  action: "buy" | "sell" | null;
  orderType: string | null;
  price: number | null;
  shares: number | null;

  reasons: string[];

  fillEvidence: BlockedFillEvidence;
  wouldFill: boolean | null;
  fillTsMs: number | null;
  fillEvidenceReason: string | null;

  markout1s: number | null;
  markout5s: number | null;
  markout30s: number | null;
  settlementMarkout: number | null;

  adverseSelection: boolean | null;
  settlementDirection: "UP" | "DOWN" | "TIE" | null;
  hypotheticalPnl: number | null;

  duplicateVerdict:
    | "unique"
    | "duplicate_same_side_same_price"
    | "duplicate_inventory_exceeded"
    | "unknown";

  verdict: BlockedCounterfactualVerdict;
  unavailableReasons: string[];
};

export type AuditOptions = {
  dedupeWindowMs?: number;
  riskMode?: BlockedCounterfactualRecord["riskMode"];
  tokenMapping?: { upTokenId: string; downTokenId: string };
};

export function evaluateBlockedIntent(
  intentEvent: ProfitEventEnvelope<StrategyPayload>,
  decisionEvent: ProfitEventEnvelope<StrategyPayload>,
  allEvents: ProfitEventEnvelope[],
  settlement: SettlementPayload | null,
  opts: AuditOptions = {}
): BlockedCounterfactualRecord {
  const intentPayload = intentEvent.payload as any;
  const decisionPayload = decisionEvent.payload as any;
  
  const intent = decisionPayload.intent ?? intentPayload;
  const decision = decisionPayload.decision;
  const id = intentPayload.intentId ?? intent.id ?? null;

  let rawSide = decisionPayload.intent?.side ?? intentPayload.side ?? intent.side;
  let side: "UP" | "DOWN" | null = (rawSide === "UP" || rawSide === "DOWN") ? rawSide : null;
  const tokenId = intent.tokenId;
  
  if (!side && typeof tokenId === "string" && opts.tokenMapping) {
    if (tokenId === opts.tokenMapping.upTokenId) side = "UP";
    else if (tokenId === opts.tokenMapping.downTokenId) side = "DOWN";
  }

  const record: BlockedCounterfactualRecord = {
    schemaVersion: 1,
    diagnosticOnly: true,
    riskMode: opts.riskMode ?? "normal-audit",
    strategy: intentEvent.strategyId ?? null,
    variant: intentPayload.variantId ?? intent.variantId ?? null,
    slug: intentEvent.slug ?? "unknown",
    timestampMs: intentEvent.processedTsMs,
    intentId: id,
    side,
    action: intent.action ?? null,
    orderType: intent.orderType ?? null,
    price: intent.price ?? null,
    shares: intent.shares ?? null,
    reasons: decision?.reasons ?? decisionPayload.reasons ?? [],
    fillEvidence: "unknown_insufficient_data",
    wouldFill: null,
    fillTsMs: null,
    fillEvidenceReason: null,
    markout1s: null,
    markout5s: null,
    markout30s: null,
    settlementMarkout: null,
    adverseSelection: null,
    settlementDirection: settlement?.direction ?? null,
    hypotheticalPnl: null,
    duplicateVerdict: "unknown",
    verdict: "inconclusive",
    unavailableReasons: [],
  };

  let isValid = true;
  if (!side) {
    record.unavailableReasons.push("missing_side");
    isValid = false;
  }
  if (typeof tokenId !== "string" || tokenId.trim().length === 0) {
    record.unavailableReasons.push("missing_token_id");
    isValid = false;
  }
  if (!Number.isFinite(record.price) || record.price! <= 0 || record.price! >= 1) {
    record.unavailableReasons.push("invalid_price");
    isValid = false;
  }
  if (!Number.isFinite(record.shares) || record.shares! <= 0) {
    record.unavailableReasons.push("invalid_shares");
    isValid = false;
  }
  if (record.action !== "buy" && record.action !== "sell") {
    record.unavailableReasons.push("invalid_action");
    isValid = false;
  }

  if (!isValid) {
    return record;
  }

  // 1. Fill Scoring
  const scorer = new ConservativeFillScorer();
  const scoreOpts: ScoreFillOptions = {
    orderId: id,
    tokenId: tokenId,
    action: record.action as "buy" | "sell",
    side: record.side as "UP" | "DOWN",
    price: record.price!,
    shares: record.shares!,
    placedTsMs: intentEvent.processedTsMs,
    queuePosition: Infinity, // Conservative: assume worst position for blocked intents
  };

  const fillResult = scorer.evaluate(scoreOpts, allEvents);
  record.fillEvidence = fillResult.verdict as BlockedFillEvidence;
  record.fillEvidenceReason = fillResult.reason;
  record.wouldFill = fillResult.verdict === "trade_through_fill" || fillResult.verdict === "probable_fill";
  record.fillTsMs = fillResult.fillTsMs;
  record.markout1s = fillResult.markouts["1s"];
  record.markout5s = fillResult.markouts["5s"];
  record.markout30s = fillResult.markouts["30s"];
  record.settlementMarkout = fillResult.markouts.settlement;
  record.adverseSelection = fillResult.adverseSelection;

  if (fillResult.verdict === "unknown_insufficient_data") {
    record.unavailableReasons.push(`fill_scorer_no_data: ${fillResult.reason}`);
  }

  // 2. Hypothetical PnL
  if (record.wouldFill && settlement?.direction && record.side) {
    const won = record.side === settlement.direction;
    const tie = settlement.direction === "TIE";
    if (tie) {
      record.hypotheticalPnl = (0.5 - intent.price) * intent.shares;
    } else {
      record.hypotheticalPnl = (won ? 1 - intent.price : -intent.price) * intent.shares;
    }
  }

  // 3. Final Verdict
  if (record.fillEvidence === "unknown_insufficient_data") {
    record.verdict = "inconclusive";
  } else if (!record.wouldFill) {
    record.verdict = "blocked_but_no_fill";
  } else {
    // We would have filled. Was it a good or bad block?
    // Use settlement PnL as the primary arbiter if available.
    if (record.hypotheticalPnl !== null) {
      record.verdict = record.hypotheticalPnl > 0 ? "bad_block" : "good_block";
    } else {
      // Fallback to markouts if settlement is missing
      const m5s = record.markout5s;
      if (m5s !== null) {
        record.verdict = m5s > 0 ? "bad_block" : "good_block";
      } else {
        record.verdict = "inconclusive";
      }
    }
  }

  return record;
}

export function deduplicateBlockedRecords(
  records: BlockedCounterfactualRecord[],
  windowMs = 1000
): BlockedCounterfactualRecord[] {
  if (records.length <= 1) return records;

  const sorted = [...records].sort((a, b) => a.timestampMs - b.timestampMs);
  const result: BlockedCounterfactualRecord[] = [];
  
  // Track last seen unique intent by strategy/side/action/price
  const lastSeen = new Map<string, BlockedCounterfactualRecord>();

  for (const record of sorted) {
    const key = `${record.strategy}:${record.side}:${record.action}:${record.price?.toFixed(2)}`;
    const prev = lastSeen.get(key);

    if (prev && record.timestampMs - prev.timestampMs <= windowMs) {
      // It's a duplicate. We keep the first one but could theoretically aggregate them.
      // For now, we label it and skip adding it to the 'unique' set if we wanted a filtered list,
      // but the user asked to preserve all raw records with labels.
      record.duplicateVerdict = "duplicate_same_side_same_price";
    } else {
      record.duplicateVerdict = "unique";
      lastSeen.set(key, record);
    }
    result.push(record);
  }

  return result;
}
