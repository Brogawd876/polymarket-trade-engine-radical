import type { StrategyLabBatch } from "../strategy-lab.ts";
import type { PairManifest } from "./pair-manifest.ts";
import type { DecisionFeatureSnapshot } from "../decision-features.ts";

export type CalibrationRecordSide = "UP" | "DOWN" | "unknown";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function probabilityForSide(probabilityUp: number | null | undefined, side: CalibrationRecordSide | undefined): number | null {
  if (probabilityUp === null || probabilityUp === undefined || side === undefined || side === "unknown") return null;
  if (side === "UP") return probabilityUp;
  return 1 - probabilityUp;
}

function edgeForAction(params: {
  action?: "buy" | "sell";
  fairValue: number | null;
  price: number | null;
}): number | null {
  if (params.fairValue === null || params.price === null || !params.action) return null;
  const raw = params.action === "buy"
    ? params.fairValue - params.price
    : params.price - params.fairValue;
  return parseFloat(raw.toFixed(6));
}

function decisionFields(
  decisionFeature: DecisionFeatureSnapshot | undefined,
  side: CalibrationRecordSide | undefined,
  action: "buy" | "sell" | undefined,
  quotedPrice: number | null,
) {
  const rawProbability = probabilityForSide(decisionFeature?.quant.probabilityUp ?? null, side);
  const fairValue = rawProbability;
  const marketImpliedProbability = quotedPrice;
  const fairValueEdge = edgeForAction({ action, fairValue, price: marketImpliedProbability });

  return {
    decisionTsMs: finiteNumber(decisionFeature?.ts),
    quoteTsMs: finiteNumber(decisionFeature?.ts),
    timeToCloseMs: finiteNumber(decisionFeature?.round.timeRemainingMs),
    modelProbability: rawProbability,
    rawProbability,
    fairValue,
    marketImpliedProbability,
    quotedEdge: fairValueEdge,
    fairValueEdge,
    bestBid: finiteNumber(decisionFeature?.orderbook.bid),
    bestAsk: finiteNumber(decisionFeature?.orderbook.ask),
    mid: decisionFeature?.orderbook.bid !== null
      && decisionFeature?.orderbook.bid !== undefined
      && decisionFeature?.orderbook.ask !== null
      && decisionFeature?.orderbook.ask !== undefined
      ? parseFloat(((decisionFeature.orderbook.bid + decisionFeature.orderbook.ask) / 2).toFixed(6))
      : null,
    spread: finiteNumber(decisionFeature?.orderbook.spread),
    topOfBookLiquidity: finiteNumber(decisionFeature?.orderbook.targetLiquidity),
    volatilityEstimate: finiteNumber(decisionFeature?.quant.sigma),
    predictiveDisagreement: decisionFeature?.feeds.predictiveDisagreement ?? null,
    predictiveDivergence: finiteNumber(decisionFeature?.feeds.divergencePct)
      ?? finiteNumber(decisionFeature?.predictiveTape.divergenceFromSettlementPct),
    resolutionDistance: finiteNumber(decisionFeature?.round.gap),
    distanceToOpenAnchor: finiteNumber(decisionFeature?.round.gap),
    strategyId: decisionFeature?.strategy.id ?? null,
    variantId: decisionFeature?.strategy.presetId ?? null,
    configHash: decisionFeature?.strategy.configHash ?? null,
  };
}

export type CalibrationRecord = {
  schemaVersion: 1;
  pairManifestPath: string;
  slug: string;
  strategy: string;
  variantName?: string;
  strategyId?: string | null;
  variantId?: string | null;
  configHash?: string | null;

  tokenId?: string;
  side?: CalibrationRecordSide;
  action?: "buy" | "sell";

  quoteTsMs?: number;
  fillTsMs?: number;
  decisionTsMs?: number;
  timeToCloseMs?: number;

  quotedPrice?: number | null;
  fillPrice?: number;
  bestBid?: number | null;
  bestAsk?: number | null;
  mid?: number | null;
  spread?: number | null;
  topOfBookLiquidity?: number | null;

  modelProbability?: number | null;
  rawProbability?: number | null;
  fairValue?: number | null;
  marketImpliedProbability?: number | null;
  quotedEdge?: number | null;
  fairValueEdge?: number | null;
  predictedProbability?: number | null;
  calibratedProbability?: null;
  volatilityEstimate?: number | null;
  predictiveDisagreement?: boolean | null;
  predictiveDivergence?: number | null;
  resolutionDistance?: number | null;
  distanceToOpenAnchor?: number | null;

  markout1s?: number | null;
  markout5s?: number | null;
  markout30s?: number | null;
  settlementMarkout?: number | null;

  conservativeFillVerdict?: string;
  adverseSelection?: boolean | null;
  pnlContribution?: number | null;

  dataQuality: {
    hasMarketTradeEvidence: boolean;
    hasBookEvidence: boolean;
    hasMarkout1s: boolean;
    hasMarkout5s: boolean;
    hasMarkout30s: boolean;
    missingReasons: string[];
  };
};

export function extractCalibrationRecords(
  batch: StrategyLabBatch,
  manifests: Map<string, PairManifest>
): CalibrationRecord[] {
  const records: CalibrationRecord[] = [];

  for (const run of batch.runs) {
    if (run.status !== "completed") continue;
    
    // Find corresponding manifest
    const manifest = [...manifests.values()].find(m => m.slug === run.slug);
    const pairManifestPath = manifest ? `data/pairs/${manifest.slug}.pair.json` : "unknown";

    const evidenceList = run.execution.conservativeFill.evidence || [];

    for (const evidence of evidenceList) {
      const quotedPrice = finiteNumber(evidence.price);
      const fields = decisionFields(evidence.decisionFeature, evidence.side, evidence.action, quotedPrice);
      const missingReasons: string[] = [];
      if (evidence.markouts["1s"] === null) missingReasons.push("missing_markout_1s");
      if (evidence.markouts["5s"] === null) missingReasons.push("missing_markout_5s");
      if (evidence.markouts["30s"] === null) missingReasons.push("missing_markout_30s");
      if (!evidence.decisionFeature) missingReasons.push("missing_decision_feature");
      if (fields.modelProbability === null) missingReasons.push("missing_model_probability");
      if (fields.fairValueEdge === null) missingReasons.push("missing_fair_value_edge");
      if (evidence.decisionFeature?.settlementTruth.settlementAnchorPrice === null ||
          evidence.decisionFeature?.settlementTruth.settlementAnchorPrice === undefined) {
        missingReasons.push("missing_chainlink_anchor");
      }
      if (evidence.decisionFeature?.settlementTruth.roundId === null ||
          evidence.decisionFeature?.settlementTruth.roundId === undefined) {
        missingReasons.push("missing_chainlink_round_id");
      }

      records.push({
        schemaVersion: 1,
        pairManifestPath,
        slug: run.slug || "unknown",
        strategy: run.strategy,
        variantName: run.variantLabel,
        strategyId: fields.strategyId ?? run.baseStrategy ?? run.strategy,
        variantId: fields.variantId ?? run.variantLabel,
        configHash: fields.configHash,

        tokenId: evidence.tokenId,
        side: evidence.side,
        action: evidence.action,

        quoteTsMs: fields.quoteTsMs ?? undefined,
        decisionTsMs: fields.decisionTsMs ?? undefined,
        fillTsMs: evidence.fillTsMs ?? evidence.placedTsMs,
        timeToCloseMs: fields.timeToCloseMs ?? undefined,
        
        quotedPrice,
        fillPrice: evidence.price,
        bestBid: fields.bestBid,
        bestAsk: fields.bestAsk,
        mid: fields.mid,
        spread: fields.spread,
        topOfBookLiquidity: fields.topOfBookLiquidity,

        modelProbability: fields.modelProbability,
        rawProbability: fields.rawProbability,
        fairValue: fields.fairValue,
        marketImpliedProbability: fields.marketImpliedProbability,
        quotedEdge: fields.quotedEdge,
        fairValueEdge: fields.fairValueEdge,
        predictedProbability: fields.modelProbability,
        calibratedProbability: null,
        volatilityEstimate: fields.volatilityEstimate,
        predictiveDisagreement: fields.predictiveDisagreement,
        predictiveDivergence: fields.predictiveDivergence,
        resolutionDistance: fields.resolutionDistance,
        distanceToOpenAnchor: fields.distanceToOpenAnchor,

        markout1s: evidence.markouts["1s"],
        markout5s: evidence.markouts["5s"],
        markout30s: evidence.markouts["30s"],
        settlementMarkout: null,

        conservativeFillVerdict: evidence.verdict,
        adverseSelection: evidence.adverseSelection,
        pnlContribution: null, // Detailed PnL per fill is not yet computed in strategy lab

        dataQuality: {
          hasMarketTradeEvidence: evidence.verdict === "trade_through_fill" || evidence.verdict === "probable_fill",
          hasBookEvidence: true,
          hasMarkout1s: evidence.markouts["1s"] !== null,
          hasMarkout5s: evidence.markouts["5s"] !== null,
          hasMarkout30s: evidence.markouts["30s"] !== null,
          missingReasons,
        }
      });
    }
  }

  return records;
}
