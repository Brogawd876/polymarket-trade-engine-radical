import {
  ACCOUNTING_SCALE,
  formatAtoms,
  minAtoms,
  multiplyAtoms,
  parseAtoms,
} from "./fixed.ts";
import { createHash } from "crypto";

export type QuoteSide = "UP" | "DOWN";

export type ExecutionProofState = {
  candidateId: string;
  side: QuoteSide;
  tokenId: string;
  orderType: "GTC";
  postOnly: true;
  requestedPrice: string;
  requestedSize: string;
  tickSize: string;
  minimumOrderSize: string;
  expectedAveragePrice: string;
  worstExecutablePrice: string;
  dynamicFeeRate: string;
  expectedFee: string;
  expectedSlippage: string;
  expectedLatencyCost: string;
  expectedAdverseSelectionCost: string;
  expectedInventoryCost: string;
  expectedCancellationCost: string;
  expectedRebateReportedSeparately: string;
  rebateContributionToApproval: "0";
  fillProbability: number;
  expectedFillFraction: number;
  fillConditionedWinProbabilityLower: number;
  conservativeEv: string;
  approved: boolean;
  riskReasons: string[];
  decisionTimestampMs: number;
  sourceSnapshotIds: string[];
};

export type QuoteGridInput = {
  side: QuoteSide;
  tokenId: string;
  bestBid: string;
  bestAsk: string;
  tickSize: string;
  minimumOrderSize: string;
  requestedSize: string;
  gridLevels: number;
  fillProbability: number;
  expectedFillFraction: number;
  fillConditionedWinProbabilityLower: number;
  expectedFutureExitCostPerShare: string;
  expectedLatencyCostPerShare: string;
  expectedAdverseSelectionCostPerShare: string;
  expectedInventoryCostPerShare: string;
  expectedCancellationCost: string;
  expectedRebate: string;
  minimumConservativeEv: string;
  decisionTimestampMs: number;
  sourceSnapshotIds: string[];
  riskReasons?: string[];
};

export type SettlementEdgeDecision = {
  outcome: "NO_TRADE" | "BLOCKED" | "ORDER_INTENT_CREATED";
  selected: ExecutionProofState | null;
  candidates: ExecutionProofState[];
  reason: string;
};

function probabilityAtoms(label: string, value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be in [0, 1]`);
  }
  return BigInt(Math.round(value * Number(ACCOUNTING_SCALE)));
}

function aligned(price: bigint, tick: bigint): boolean {
  return price % tick === 0n;
}

function stableCandidateId(input: QuoteGridInput, level: number, price: bigint) {
  return `candidate:${createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        riskReasons: [...(input.riskReasons ?? [])].sort(),
        sourceSnapshotIds: [...input.sourceSnapshotIds].sort(),
        level,
        price: formatAtoms(price),
      }),
    )
    .digest("hex")}`;
}

/**
 * Pure, submission-incapable SettlementEdgeMaker policy. It emits a selected
 * intent proof; only the authoritative kernel may turn that proof into an
 * outbox command.
 */
export class SettlementEdgeMaker {
  evaluate(input: QuoteGridInput): SettlementEdgeDecision {
    const tick = parseAtoms(input.tickSize);
    const bestBid = parseAtoms(input.bestBid);
    const bestAsk = parseAtoms(input.bestAsk);
    const size = parseAtoms(input.requestedSize);
    const minimumSize = parseAtoms(input.minimumOrderSize);
    const minimumEv = parseAtoms(input.minimumConservativeEv);
    if (
      tick <= 0n ||
      bestBid <= 0n ||
      bestAsk <= bestBid ||
      size < minimumSize ||
      input.gridLevels <= 0
    ) {
      return {
        outcome: "BLOCKED",
        selected: null,
        candidates: [],
        reason: "invalid book, tick, size, or quote-grid input",
      };
    }
    if (!aligned(bestBid, tick) || !aligned(bestAsk, tick)) {
      return {
        outcome: "BLOCKED",
        selected: null,
        candidates: [],
        reason: "book prices are not tick aligned",
      };
    }

    const explicitRiskReasons = input.riskReasons ?? [];
    const candidates: ExecutionProofState[] = [];
    const q = probabilityAtoms("fill probability", input.fillProbability);
    const fraction = probabilityAtoms(
      "expected fill fraction",
      input.expectedFillFraction,
    );
    const win = probabilityAtoms(
      "fill-conditioned win lower bound",
      input.fillConditionedWinProbabilityLower,
    );
    const effectiveQuantity = multiplyAtoms(
      multiplyAtoms(size, q),
      fraction,
    );
    const perShareCosts =
      parseAtoms(input.expectedFutureExitCostPerShare) +
      parseAtoms(input.expectedLatencyCostPerShare) +
      parseAtoms(input.expectedAdverseSelectionCostPerShare) +
      parseAtoms(input.expectedInventoryCostPerShare);
    const cancellationCost = parseAtoms(input.expectedCancellationCost);

    for (let level = 0; level < input.gridLevels; level += 1) {
      const price = bestBid + tick * BigInt(level);
      if (price >= bestAsk) break;
      const edgePerShare = win - price - perShareCosts;
      const ev = multiplyAtoms(effectiveQuantity, edgePerShare) - cancellationCost;
      const riskReasons = [...explicitRiskReasons];
      if (ev < minimumEv) riskReasons.push("conservative EV below margin");
      const candidate: ExecutionProofState = {
        candidateId: stableCandidateId(input, level, price),
        side: input.side,
        tokenId: input.tokenId,
        orderType: "GTC",
        postOnly: true,
        requestedPrice: formatAtoms(price),
        requestedSize: formatAtoms(size),
        tickSize: input.tickSize,
        minimumOrderSize: input.minimumOrderSize,
        expectedAveragePrice: formatAtoms(price),
        worstExecutablePrice: formatAtoms(price),
        dynamicFeeRate: "0",
        expectedFee: "0",
        expectedSlippage: "0",
        expectedLatencyCost: formatAtoms(
          multiplyAtoms(
            effectiveQuantity,
            parseAtoms(input.expectedLatencyCostPerShare),
          ),
        ),
        expectedAdverseSelectionCost: formatAtoms(
          multiplyAtoms(
            effectiveQuantity,
            parseAtoms(input.expectedAdverseSelectionCostPerShare),
          ),
        ),
        expectedInventoryCost: formatAtoms(
          multiplyAtoms(
            effectiveQuantity,
            parseAtoms(input.expectedInventoryCostPerShare),
          ),
        ),
        expectedCancellationCost: input.expectedCancellationCost,
        expectedRebateReportedSeparately: input.expectedRebate,
        rebateContributionToApproval: "0",
        fillProbability: input.fillProbability,
        expectedFillFraction: input.expectedFillFraction,
        fillConditionedWinProbabilityLower:
          input.fillConditionedWinProbabilityLower,
        conservativeEv: formatAtoms(ev),
        approved: riskReasons.length === 0,
        riskReasons,
        decisionTimestampMs: input.decisionTimestampMs,
        sourceSnapshotIds: [...input.sourceSnapshotIds],
      };
      candidates.push(candidate);
    }

    const selected = candidates
      .filter((candidate) => candidate.approved)
      .sort(
        (left, right) =>
          Number(
            parseAtoms(right.conservativeEv) -
              parseAtoms(left.conservativeEv),
          ),
      )[0];
    if (!selected) {
      return {
        outcome:
          explicitRiskReasons.length > 0 ? "BLOCKED" : "NO_TRADE",
        selected: null,
        candidates,
        reason:
          explicitRiskReasons.length > 0
            ? explicitRiskReasons.join("; ")
            : "no quote has positive conservative utility",
      };
    }
    return {
      outcome: "ORDER_INTENT_CREATED",
      selected,
      candidates,
      reason: "highest positive conservative utility",
    };
  }
}

export type ExitBookLevel = { price: string; quantity: string };

export type ExitDecision = {
  action: "SELL" | "HOLD" | "BLOCKED";
  orderType: "FOK" | "FAK" | "GTC" | null;
  requestedQuantity: string;
  executableQuantity: string;
  averagePrice: string | null;
  worstPrice: string | null;
  sellValue: string;
  holdRiskAdjustedValue: string;
  hysteresis: string;
  expectedFee: string;
  remainingQuantityAfterExit: string;
  reason: string;
};

export function evaluateEconomicExit(input: {
  quantity: string;
  bids: ExitBookLevel[];
  holdProbability: number;
  takerFeeRate: string;
  latencyCost: string;
  riskLambda: string;
  capitalCost: string;
  stalenessCost: string;
  uncertaintyCost: string;
  hysteresis: string;
  fullExitRequired: boolean;
  partialAcceptable: boolean;
  intentionallyRestingMaker: boolean;
}): ExitDecision {
  const quantity = parseAtoms(input.quantity);
  const probability = probabilityAtoms("hold probability", input.holdProbability);
  const feeRate = parseAtoms(input.takerFeeRate);
  let remaining = quantity;
  let gross = 0n;
  let fee = 0n;
  let executable = 0n;
  let worst: bigint | null = null;
  for (const level of input.bids) {
    const price = parseAtoms(level.price);
    const available = parseAtoms(level.quantity);
    const used = minAtoms(remaining, available);
    if (used <= 0n) continue;
    const levelGross = multiplyAtoms(used, price);
    const curve = multiplyAtoms(price, ACCOUNTING_SCALE - price);
    const levelFee = multiplyAtoms(multiplyAtoms(used, feeRate), curve);
    gross += levelGross;
    fee += levelFee;
    executable += used;
    remaining -= used;
    worst = price;
    if (remaining === 0n) break;
  }
  if (executable === 0n) {
    return {
      action: "BLOCKED",
      orderType: null,
      requestedQuantity: input.quantity,
      executableQuantity: "0",
      averagePrice: null,
      worstPrice: null,
      sellValue: "0",
      holdRiskAdjustedValue: "0",
      hysteresis: input.hysteresis,
      expectedFee: "0",
      remainingQuantityAfterExit: input.quantity,
      reason: "no executable bid depth",
    };
  }
  if (input.fullExitRequired && remaining > 0n) {
    return {
      action: "BLOCKED",
      orderType: null,
      requestedQuantity: input.quantity,
      executableQuantity: formatAtoms(executable),
      averagePrice: formatAtoms(
        (gross * ACCOUNTING_SCALE) / executable,
      ),
      worstPrice: worst === null ? null : formatAtoms(worst),
      sellValue: formatAtoms(gross - fee - parseAtoms(input.latencyCost)),
      holdRiskAdjustedValue: "0",
      hysteresis: input.hysteresis,
      expectedFee: formatAtoms(fee),
      remainingQuantityAfterExit: formatAtoms(remaining),
      reason: "insufficient depth for required full exit",
    };
  }

  const sellValue = gross - fee - parseAtoms(input.latencyCost);
  const holdExpected = multiplyAtoms(quantity, probability);
  const variance = multiplyAtoms(
    probability,
    ACCOUNTING_SCALE - probability,
  );
  const quantitySquared = multiplyAtoms(quantity, quantity);
  const riskPenalty = multiplyAtoms(
    multiplyAtoms(parseAtoms(input.riskLambda), quantitySquared),
    variance,
  );
  const holdValue =
    holdExpected -
    riskPenalty -
    parseAtoms(input.capitalCost) -
    parseAtoms(input.stalenessCost) -
    parseAtoms(input.uncertaintyCost);
  const hysteresis = parseAtoms(input.hysteresis);
  const sell = sellValue > holdValue + hysteresis;
  const orderType = sell
    ? input.intentionallyRestingMaker
      ? "GTC"
      : remaining === 0n && input.fullExitRequired
        ? "FOK"
        : input.partialAcceptable
          ? "FAK"
          : "FOK"
    : null;
  return {
    action: sell ? "SELL" : "HOLD",
    orderType,
    requestedQuantity: input.quantity,
    executableQuantity: formatAtoms(executable),
    averagePrice: formatAtoms((gross * ACCOUNTING_SCALE) / executable),
    worstPrice: worst === null ? null : formatAtoms(worst),
    sellValue: formatAtoms(sellValue),
    holdRiskAdjustedValue: formatAtoms(holdValue),
    hysteresis: input.hysteresis,
    expectedFee: formatAtoms(fee),
    remainingQuantityAfterExit: formatAtoms(remaining),
    reason: sell
      ? "depth-walked sell value exceeds risk-adjusted hold plus hysteresis"
      : "risk-adjusted hold value remains greater",
  };
}

export type PairedCostDecision = {
  lockedArbitrage: boolean;
  upWinsPnl: string;
  downWinsPnl: string;
  minimumScenarioPnl: string;
  nakedLegNotional: string;
  blockedReasons: string[];
};

/** Isolated analysis-only policy; this class has no execution dependency. */
export class PairedCostShadowStrategy {
  evaluate(input: {
    confirmedUpQuantity: string;
    confirmedDownQuantity: string;
    upAcquisitionCost: string;
    downAcquisitionCost: string;
    allFeesAndExecutionCosts: string;
    pendingUnmatchedCost: string;
    nakedLegStartedAtMs: number | null;
    decisionTimestampMs: number;
    maximumNakedLegNotional: string;
    maximumNakedLegMs: number;
    safetyBuffer: string;
  }): PairedCostDecision {
    const upQuantity = parseAtoms(input.confirmedUpQuantity);
    const downQuantity = parseAtoms(input.confirmedDownQuantity);
    const totalCost =
      parseAtoms(input.upAcquisitionCost) +
      parseAtoms(input.downAcquisitionCost) +
      parseAtoms(input.allFeesAndExecutionCosts) +
      parseAtoms(input.pendingUnmatchedCost);
    const upPnl = upQuantity - totalCost;
    const downPnl = downQuantity - totalCost;
    const minimum = upPnl < downPnl ? upPnl : downPnl;
    const nakedQuantity =
      upQuantity > downQuantity
        ? upQuantity - downQuantity
        : downQuantity - upQuantity;
    const nakedNotional = nakedQuantity;
    const reasons: string[] = [];
    if (nakedNotional > parseAtoms(input.maximumNakedLegNotional)) {
      reasons.push("maximum naked-leg notional exceeded");
    }
    if (
      input.nakedLegStartedAtMs !== null &&
      input.decisionTimestampMs - input.nakedLegStartedAtMs >
        input.maximumNakedLegMs
    ) {
      reasons.push("maximum naked-leg time exceeded");
    }
    if (parseAtoms(input.pendingUnmatchedCost) > 0n) {
      reasons.push("pending unmatched second-leg cost remains");
    }
    return {
      lockedArbitrage:
        reasons.length === 0 && minimum > parseAtoms(input.safetyBuffer),
      upWinsPnl: formatAtoms(upPnl),
      downWinsPnl: formatAtoms(downPnl),
      minimumScenarioPnl: formatAtoms(minimum),
      nakedLegNotional: formatAtoms(nakedNotional),
      blockedReasons: reasons,
    };
  }
}
