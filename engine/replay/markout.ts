import type { ReplayEvent } from "../bot-core/replay-log-reader.ts";

export type MarkoutHorizon = 1000 | 5000 | 30000 | "settlement";

export type MarkoutUnavailableReason =
  | "missing_reference"
  | "missing_horizon"
  | "missing_fill";

export type FillForMarkout = {
  orderId: string;
  tsMs: number;
  side: "UP" | "DOWN";
  action: "buy" | "sell";
  price: number;
};

export type ReferencePricePoint = {
  tsMs: number;
  upMid?: number | null;
  downMid?: number | null;
  upBid?: number | null;
  upAsk?: number | null;
  downBid?: number | null;
  downAsk?: number | null;
  settlementUpValue?: number | null;
};

export type MarkoutResult = {
  orderId: string;
  horizon: MarkoutHorizon;
  available: boolean;
  value: number | null;
  referencePrice: number | null;
  referenceTsMs: number | null;
  targetTsMs: number | null;
  distanceFromTargetMs: number | null;
  reason?: MarkoutUnavailableReason;
};

export type MarkoutOptions = {
  maxObservationDistanceMs?: number;
  skipSort?: boolean;
};

export type MarkoutSummary = {
  oneSecond: number | null;
  fiveSecond: number | null;
  thirtySecond: number | null;
  settlement: number | null;
  samples: number;
  unavailableCount: number;
  unavailableReasons: Record<string, number>;
};

const DEFAULT_MAX_OBSERVATION_DISTANCE_MS = 1500;

export function calculateMarkouts(
  fill: FillForMarkout | null,
  references: ReferencePricePoint[],
  opts: MarkoutOptions = {},
): MarkoutResult[] {
  const horizons: MarkoutHorizon[] = [1000, 5000, 30000, "settlement"];
  if (!fill) {
    return horizons.map((horizon) => ({
      orderId: "",
      horizon,
      available: false,
      value: null,
      referencePrice: null,
      referenceTsMs: null,
      targetTsMs: null,
      distanceFromTargetMs: null,
      reason: "missing_fill",
    }));
  }

  const sorted = opts.skipSort ? references : [...references].sort((a, b) => a.tsMs - b.tsMs);
  return horizons.map((horizon) => calculateMarkout(fill, sorted, horizon, opts));
}

export function calculateMarkout(
  fill: FillForMarkout,
  references: ReferencePricePoint[],
  horizon: MarkoutHorizon,
  opts: MarkoutOptions = {},
): MarkoutResult {
  const targetTsMs = horizon === "settlement" ? null : fill.tsMs + horizon;
  const reference =
    horizon === "settlement"
      ? references.findLast((point) => point.settlementUpValue !== undefined)
      : findHorizonReference(fill, references, horizon, opts);

  if (!reference) {
    return {
      orderId: fill.orderId,
      horizon,
      available: false,
      value: null,
      referencePrice: null,
      referenceTsMs: null,
      targetTsMs,
      distanceFromTargetMs: null,
      reason: "missing_horizon",
    };
  }

  const referencePrice = priceForSide(reference, fill.side, horizon);
  if (referencePrice === null) {
    return {
      orderId: fill.orderId,
      horizon,
      available: false,
      value: null,
      referencePrice: null,
      referenceTsMs: reference.tsMs,
      targetTsMs,
      distanceFromTargetMs: targetTsMs === null ? null : reference.tsMs - targetTsMs,
      reason: "missing_reference",
    };
  }

  const signed =
    fill.action === "buy"
      ? referencePrice - fill.price
      : fill.price - referencePrice;
  return {
    orderId: fill.orderId,
    horizon,
    available: true,
    value: parseFloat(signed.toFixed(6)),
    referencePrice,
    referenceTsMs: reference.tsMs,
    targetTsMs,
    distanceFromTargetMs: targetTsMs === null ? null : reference.tsMs - targetTsMs,
  };
}

export function summarizeMarkouts(results: MarkoutResult[]): MarkoutSummary {
  const byHorizon = new Map<MarkoutHorizon, MarkoutResult[]>();
  for (const result of results) {
    const current = byHorizon.get(result.horizon) ?? [];
    current.push(result);
    byHorizon.set(result.horizon, current);
  }
  const unavailableReasons: Record<string, number> = {};
  let samples = 0;
  let unavailableCount = 0;
  for (const result of results) {
    if (result.available && result.value !== null) {
      samples += 1;
    } else {
      unavailableCount += 1;
      const key = `${labelForHorizon(result.horizon)}:${result.reason ?? "unknown"}`;
      unavailableReasons[key] = (unavailableReasons[key] ?? 0) + 1;
    }
  }
  return {
    oneSecond: averageResults(byHorizon.get(1000) ?? []),
    fiveSecond: averageResults(byHorizon.get(5000) ?? []),
    thirtySecond: averageResults(byHorizon.get(30000) ?? []),
    settlement: averageResults(byHorizon.get("settlement") ?? []),
    samples,
    unavailableCount,
    unavailableReasons,
  };
}

export function extractReferencePricesFromReplayEvents(
  events: ReplayEvent[],
): ReferencePricePoint[] {
  const references: ReferencePricePoint[] = [];
  for (const event of events) {
    if (event.type !== "orderbook_snapshot") continue;
    references.push({
      tsMs: event.ts,
      upBid: bestPrice(event.up?.bids),
      upAsk: bestPrice(event.up?.asks),
      downBid: bestPrice(event.down?.bids),
      downAsk: bestPrice(event.down?.asks),
    });
  }
  return references;
}

export function appendSettlementReference(
  references: ReferencePricePoint[],
  settlement: { tsMs: number; direction: "UP" | "DOWN" | "TIE" },
): ReferencePricePoint[] {
  const settlementUpValue =
    settlement.direction === "UP" ? 1 : settlement.direction === "DOWN" ? 0 : 0.5;
  return [...references, { tsMs: settlement.tsMs, settlementUpValue }];
}

function findHorizonReference(
  fill: FillForMarkout,
  references: ReferencePricePoint[],
  horizon: Exclude<MarkoutHorizon, "settlement">,
  opts: MarkoutOptions,
): ReferencePricePoint | null {
  const target = fill.tsMs + horizon;
  const tolerance = opts.maxObservationDistanceMs ?? DEFAULT_MAX_OBSERVATION_DISTANCE_MS;
  
  let startIndex = 0;
  let low = 0;
  let high = references.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const midRef = references[mid];
    if (!midRef) break;
    if (midRef.tsMs < fill.tsMs) {
      low = mid + 1;
    } else {
      startIndex = mid;
      high = mid - 1;
    }
  }
  if (low === references.length) startIndex = references.length;

  let nearest: ReferencePricePoint | null = null;
  let nearestDistance = Infinity;
  let later: ReferencePricePoint | null = null;

  for (let i = startIndex; i < references.length; i++) {
    const point = references[i];
    if (!point) continue;
    if (point.tsMs >= target) {
      later = point;
      break;
    }
    const distance = Math.abs(point.tsMs - target);
    if (distance <= tolerance && distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }

  if (later && later.tsMs - target <= tolerance) {
    return later;
  }
  return nearest;
}

function bestPrice(levels: unknown): number | null {
  if (!Array.isArray(levels)) return null;
  const first = levels[0];
  if (!Array.isArray(first)) return null;
  const price = first[0];
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

function averageResults(results: MarkoutResult[]): number | null {
  const values = results
    .map((result) => result.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  return parseFloat((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6));
}

function labelForHorizon(horizon: MarkoutHorizon): string {
  return horizon === 1000
    ? "1s"
    : horizon === 5000
      ? "5s"
      : horizon === 30000
        ? "30s"
        : "settlement";
}

function priceForSide(
  point: ReferencePricePoint,
  side: "UP" | "DOWN",
  horizon: MarkoutHorizon,
): number | null {
  if (horizon === "settlement" && point.settlementUpValue !== undefined) {
    if (point.settlementUpValue === null) return null;
    return side === "UP" ? point.settlementUpValue : 1 - point.settlementUpValue;
  }
  const explicitMid = side === "UP" ? point.upMid : point.downMid;
  if (explicitMid !== undefined && explicitMid !== null) return explicitMid;
  const bid = side === "UP" ? point.upBid : point.downBid;
  const ask = side === "UP" ? point.upAsk : point.downAsk;
  if (bid !== undefined && bid !== null && ask !== undefined && ask !== null) {
    return parseFloat(((bid + ask) / 2).toFixed(6));
  }
  return null;
}
