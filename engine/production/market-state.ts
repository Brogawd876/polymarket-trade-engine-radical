import { createHash } from "crypto";
import { parseAtoms } from "./fixed.ts";

export const CANONICAL_STATE_SCHEMA_VERSION = 1 as const;

export type FeeDetails = {
  makerRateBps: string;
  takerBaseRateBps: string;
  exponent: string;
  effectiveAtMs: number;
  sourceEvidenceId: string;
};

export type MarketContractState = {
  schemaVersion: typeof CANONICAL_STATE_SCHEMA_VERSION;
  marketId: string;
  eventId: string;
  conditionId: string;
  slug: string;
  windowStartMs: number;
  windowEndMs: number;
  acceptingOrders: boolean;
  upTokenId: string;
  downTokenId: string;
  outcomeMapping: Record<string, "UP" | "DOWN">;
  tickSize: string;
  minimumOrderSize: string;
  feeDetails: FeeDetails;
  marketType: "BTC_UP_DOWN_5M";
  resolutionSource: "CHAINLINK_POLYGON_BTC_USD";
  equalityResolvesUp: boolean;
  officialPriceToBeat: string | null;
  anchorSource: string | null;
  anchorObservationTimestampMs: number | null;
  anchorIngestTimestampMs: number | null;
  anchorEvidenceId: string | null;
  anchorVerified: boolean;
  rulesHash: string;
  metadataHash: string;
};

export type OfficialMarketMetadata = {
  marketId: string;
  eventId: string;
  conditionId: string;
  slug: string;
  windowStartMs: number;
  windowEndMs: number;
  acceptingOrders: boolean;
  outcomes: Array<{ name: string; tokenId: string }>;
  tickSize: string;
  minimumOrderSize: string;
  feeDetails: FeeDetails;
  resolutionSource: string;
  equalityResolvesUp: boolean;
  rulesText: string;
  rawMetadata: unknown;
};

export type FeedObservation = {
  schemaVersion: typeof CANONICAL_STATE_SCHEMA_VERSION;
  source: string;
  instrument: string;
  sourceSequence?: string;
  sourceTimestampMs: number;
  ingestTimestampMs: number;
  monotonicIngestNs: string;
  value: string | null;
  bid: string | null;
  ask: string | null;
  size: string | null;
  originalPayloadHash: string;
  valid: boolean;
  exclusionReason: string | null;
};

export type AnchorProof = {
  schemaVersion: typeof CANONICAL_STATE_SCHEMA_VERSION;
  anchorEvidenceId: string;
  marketId: string;
  conditionId: string;
  slug: string;
  rulesHash: string;
  priceToBeat: string;
  sourceTimestampMs: number;
  ingestTimestampMs: number;
  sourceEndpoint: string;
  sourceTopic: string;
  rawPayloadHash: string;
  comparisonEvidenceId: string;
  comparisonPrice: string;
  comparisonResult: "EXACT_MATCH" | "MISMATCH";
  approved: boolean;
  blockingReason: string | null;
};

function hashCanonical(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    }
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function assertNonEmpty(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function parseSlotStart(slug: string): number {
  const match = /^btc-updown-5m-(\d+)$/.exec(slug);
  if (!match) throw new Error(`unsupported BTC five-minute slug ${slug}`);
  return Number(match[1]) * 1000;
}

export class MarketRegistry {
  private readonly contracts = new Map<string, MarketContractState>();

  register(metadata: OfficialMarketMetadata): MarketContractState {
    for (const [label, value] of [
      ["marketId", metadata.marketId],
      ["eventId", metadata.eventId],
      ["conditionId", metadata.conditionId],
      ["slug", metadata.slug],
    ] as const) {
      assertNonEmpty(label, value);
    }
    const slugStart = parseSlotStart(metadata.slug);
    if (
      metadata.windowStartMs !== slugStart ||
      metadata.windowEndMs !== slugStart + 300_000
    ) {
      throw new Error("market window does not exactly match the five-minute slug");
    }
    if (
      metadata.resolutionSource.trim().toLowerCase() !==
      "chainlink btc/usd on polygon"
    ) {
      throw new Error(
        `unsupported designated resolution source: ${metadata.resolutionSource}`,
      );
    }
    if (!metadata.equalityResolvesUp) {
      throw new Error("market rules do not prove equality resolves UP");
    }
    parseAtoms(metadata.tickSize);
    parseAtoms(metadata.minimumOrderSize);
    if (
      parseAtoms(metadata.tickSize) <= 0n ||
      parseAtoms(metadata.minimumOrderSize) <= 0n
    ) {
      throw new Error("tick size and minimum order size must be positive");
    }

    const mapping: Record<string, "UP" | "DOWN"> = {};
    for (const outcome of metadata.outcomes) {
      const normalized = outcome.name.trim().toUpperCase();
      if (normalized !== "UP" && normalized !== "DOWN") continue;
      if (mapping[outcome.tokenId]) {
        throw new Error(`duplicate official token mapping ${outcome.tokenId}`);
      }
      mapping[outcome.tokenId] = normalized;
    }
    const upTokenId = Object.entries(mapping).find(([, side]) => side === "UP")?.[0];
    const downTokenId = Object.entries(mapping).find(([, side]) => side === "DOWN")?.[0];
    if (!upTokenId || !downTokenId || upTokenId === downTokenId) {
      throw new Error("official metadata must provide distinct UP and DOWN tokens");
    }

    const contract: MarketContractState = {
      schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
      marketId: metadata.marketId,
      eventId: metadata.eventId,
      conditionId: metadata.conditionId,
      slug: metadata.slug,
      windowStartMs: metadata.windowStartMs,
      windowEndMs: metadata.windowEndMs,
      acceptingOrders: metadata.acceptingOrders,
      upTokenId,
      downTokenId,
      outcomeMapping: mapping,
      tickSize: metadata.tickSize,
      minimumOrderSize: metadata.minimumOrderSize,
      feeDetails: structuredClone(metadata.feeDetails),
      marketType: "BTC_UP_DOWN_5M",
      resolutionSource: "CHAINLINK_POLYGON_BTC_USD",
      equalityResolvesUp: true,
      officialPriceToBeat: null,
      anchorSource: null,
      anchorObservationTimestampMs: null,
      anchorIngestTimestampMs: null,
      anchorEvidenceId: null,
      anchorVerified: false,
      rulesHash: hashCanonical(metadata.rulesText),
      metadataHash: hashCanonical(metadata.rawMetadata),
    };
    this.contracts.set(metadata.marketId, contract);
    return structuredClone(contract);
  }

  attachAnchor(marketId: string, proof: AnchorProof): MarketContractState {
    const contract = this.require(marketId);
    if (
      proof.marketId !== contract.marketId ||
      proof.conditionId !== contract.conditionId ||
      proof.slug !== contract.slug ||
      proof.rulesHash !== contract.rulesHash
    ) {
      throw new Error("anchor proof market identity mismatch");
    }
    if (!proof.approved || proof.comparisonResult !== "EXACT_MATCH") {
      throw new Error(
        `anchor proof is blocked: ${proof.blockingReason ?? proof.comparisonResult}`,
      );
    }
    const updated: MarketContractState = {
      ...contract,
      officialPriceToBeat: proof.priceToBeat,
      anchorSource: `${proof.sourceEndpoint}#${proof.sourceTopic}`,
      anchorObservationTimestampMs: proof.sourceTimestampMs,
      anchorIngestTimestampMs: proof.ingestTimestampMs,
      anchorEvidenceId: proof.anchorEvidenceId,
      anchorVerified: true,
    };
    this.contracts.set(marketId, updated);
    return structuredClone(updated);
  }

  updateDynamicInfo(
    marketId: string,
    input: Pick<
      MarketContractState,
      "acceptingOrders" | "tickSize" | "minimumOrderSize" | "feeDetails"
    >,
  ): MarketContractState {
    const tickSize = parseAtoms(input.tickSize);
    const minimumOrderSize = parseAtoms(input.minimumOrderSize);
    if (tickSize <= 0n || minimumOrderSize <= 0n) {
      throw new Error("tick size and minimum order size must be positive");
    }
    const current = this.require(marketId);
    const updated = {
      ...current,
      ...structuredClone(input),
    };
    this.contracts.set(marketId, updated);
    return structuredClone(updated);
  }

  requireTradable(marketId: string, expectedSlotStartMs: number): MarketContractState {
    const state = this.require(marketId);
    if (state.windowStartMs !== expectedSlotStartMs) {
      throw new Error("active market is not the intended current five-minute slot");
    }
    if (!state.acceptingOrders) throw new Error("market is not accepting orders");
    if (!state.anchorVerified || !state.officialPriceToBeat) {
      throw new Error("market has no verified Price to Beat");
    }
    return state;
  }

  get(marketId: string): MarketContractState | null {
    const contract = this.contracts.get(marketId);
    return contract ? structuredClone(contract) : null;
  }

  private require(marketId: string): MarketContractState {
    const contract = this.contracts.get(marketId);
    if (!contract) throw new Error(`unknown market ${marketId}`);
    return contract;
  }
}

export function createFeedObservation(
  input: Omit<FeedObservation, "schemaVersion" | "originalPayloadHash"> & {
    rawPayload: unknown;
  },
): FeedObservation {
  if (input.sourceTimestampMs > input.ingestTimestampMs + 5_000) {
    throw new Error("feed source timestamp is implausibly ahead of ingestion");
  }
  for (const value of [input.value, input.bid, input.ask, input.size]) {
    if (value !== null) parseAtoms(value);
  }
  const { rawPayload, ...rest } = input;
  return {
    schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
    ...rest,
    originalPayloadHash: hashCanonical(rawPayload),
  };
}

export function proveAnchor(input: {
  contract: MarketContractState;
  designatedSource: string;
  exactPrice: string;
  sourceTimestampMs: number;
  ingestTimestampMs: number;
  sourceEndpoint: string;
  sourceTopic: string;
  rawPayload: unknown;
  comparisonEvidenceId: string;
  comparisonExactPrice: string;
  maximumSourceAgeAtWindowMs: number;
}): AnchorProof {
  parseAtoms(input.exactPrice);
  parseAtoms(input.comparisonExactPrice);
  const blocking: string[] = [];
  if (input.designatedSource !== "CHAINLINK_POLYGON_BTC_USD") {
    blocking.push("anchor did not come from the designated Chainlink source");
  }
  if (input.sourceTimestampMs > input.contract.windowStartMs) {
    blocking.push("anchor observation is after the market window start");
  }
  if (
    input.contract.windowStartMs - input.sourceTimestampMs >
    input.maximumSourceAgeAtWindowMs
  ) {
    blocking.push("anchor observation is stale at the market window start");
  }
  if (input.ingestTimestampMs < input.sourceTimestampMs) {
    blocking.push("anchor ingestion precedes source time");
  }
  if (parseAtoms(input.exactPrice) !== parseAtoms(input.comparisonExactPrice)) {
    blocking.push("official Price-to-Beat comparison mismatched");
  }
  const evidenceCore = {
    marketId: input.contract.marketId,
    conditionId: input.contract.conditionId,
    exactPrice: input.exactPrice,
    sourceTimestampMs: input.sourceTimestampMs,
    rawPayloadHash: hashCanonical(input.rawPayload),
  };
  return {
    schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
    anchorEvidenceId: `anchor:${hashCanonical(evidenceCore)}`,
    marketId: input.contract.marketId,
    conditionId: input.contract.conditionId,
    slug: input.contract.slug,
    rulesHash: input.contract.rulesHash,
    priceToBeat: input.exactPrice,
    sourceTimestampMs: input.sourceTimestampMs,
    ingestTimestampMs: input.ingestTimestampMs,
    sourceEndpoint: input.sourceEndpoint,
    sourceTopic: input.sourceTopic,
    rawPayloadHash: evidenceCore.rawPayloadHash,
    comparisonEvidenceId: input.comparisonEvidenceId,
    comparisonPrice: input.comparisonExactPrice,
    comparisonResult:
      parseAtoms(input.exactPrice) === parseAtoms(input.comparisonExactPrice)
        ? "EXACT_MATCH"
        : "MISMATCH",
    approved: blocking.length === 0,
    blockingReason: blocking.length > 0 ? blocking.join("; ") : null,
  };
}

export function observationAges(
  observation: FeedObservation,
  decisionTimestampMs: number,
): { sourceAgeMs: number; ingestAgeMs: number; transportLagMs: number } {
  return {
    sourceAgeMs: decisionTimestampMs - observation.sourceTimestampMs,
    ingestAgeMs: decisionTimestampMs - observation.ingestTimestampMs,
    transportLagMs:
      observation.ingestTimestampMs - observation.sourceTimestampMs,
  };
}
