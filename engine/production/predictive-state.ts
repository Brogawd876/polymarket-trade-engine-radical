import type { FeedObservation } from "./market-state.ts";
import { observationAges } from "./market-state.ts";

type VenueConfig = {
  basisLog: number;
  reliability: number;
  maximumSourceAgeMs: number;
};

export type PredictiveVenueState = {
  source: string;
  adjustedPrice: number | null;
  basisLog: number;
  reliability: number;
  sourceAgeMs: number | null;
  ingestAgeMs: number | null;
  transportLagMs: number | null;
  included: boolean;
  exclusionReason: string | null;
};

export type PredictiveState = {
  schemaVersion: 1;
  venues: Record<string, PredictiveVenueState>;
  robustAdjustedComposite: number | null;
  compositeConfidence: number;
  availableVenueCount: number;
  disagreementStatistic: number | null;
  disagreementMethod: "basis-volatility-latency-reliability-v1";
};

export class PredictiveFeedService {
  private readonly observations = new Map<string, FeedObservation>();

  constructor(private readonly configs: Record<string, VenueConfig>) {
    for (const [source, config] of Object.entries(configs)) {
      if (
        !Number.isFinite(config.basisLog) ||
        !(config.reliability > 0 && config.reliability <= 1) ||
        config.maximumSourceAgeMs <= 0
      ) {
        throw new Error(`invalid predictive source configuration for ${source}`);
      }
    }
  }

  update(observation: FeedObservation): void {
    if (!this.configs[observation.source]) {
      throw new Error(`unconfigured predictive source ${observation.source}`);
    }
    this.observations.set(observation.source, structuredClone(observation));
  }

  snapshot(input: {
    decisionTimestampMs: number;
    predictedOraclePrice: number;
    expectedIntegratedVariance: number;
    minimumVenueCount: number;
  }): PredictiveState {
    if (
      !Number.isFinite(input.predictedOraclePrice) ||
      input.predictedOraclePrice <= 0 ||
      !Number.isFinite(input.expectedIntegratedVariance) ||
      input.expectedIntegratedVariance <= 0
    ) {
      throw new Error("normalized disagreement requires positive price and variance");
    }
    const venues: Record<string, PredictiveVenueState> = {};
    const included: Array<{
      adjustedPrice: number;
      reliability: number;
      sourceAgeMs: number;
      maximumSourceAgeMs: number;
    }> = [];

    for (const [source, config] of Object.entries(this.configs)) {
      const observation = this.observations.get(source);
      if (!observation?.valid || observation.value === null) {
        venues[source] = {
          source,
          adjustedPrice: null,
          basisLog: config.basisLog,
          reliability: config.reliability,
          sourceAgeMs: null,
          ingestAgeMs: null,
          transportLagMs: null,
          included: false,
          exclusionReason:
            observation?.exclusionReason ?? "missing valid observation",
        };
        continue;
      }
      const ages = observationAges(observation, input.decisionTimestampMs);
      const raw = Number(observation.value);
      const adjusted = raw * Math.exp(-config.basisLog);
      const stale =
        ages.sourceAgeMs < 0 ||
        ages.sourceAgeMs > config.maximumSourceAgeMs ||
        ages.ingestAgeMs < 0;
      venues[source] = {
        source,
        adjustedPrice: adjusted,
        basisLog: config.basisLog,
        reliability: config.reliability,
        ...ages,
        included: !stale,
        exclusionReason: stale ? "stale predictive observation" : null,
      };
      if (!stale) {
        included.push({
          adjustedPrice: adjusted,
          reliability: config.reliability,
          sourceAgeMs: ages.sourceAgeMs,
          maximumSourceAgeMs: config.maximumSourceAgeMs,
        });
      }
    }

    const totalWeight = included.reduce(
      (sum, venue) => sum + venue.reliability,
      0,
    );
    const composite =
      totalWeight > 0
        ? included.reduce(
            (sum, venue) =>
              sum + venue.adjustedPrice * venue.reliability,
            0,
          ) / totalWeight
        : null;
    const standardDeviation = Math.sqrt(input.expectedIntegratedVariance);
    const residuals = included.map((venue) => {
      const normalizedResidual =
        Math.abs(
          Math.log(venue.adjustedPrice / input.predictedOraclePrice),
        ) / (standardDeviation + 1e-12);
      const latencyPenalty =
        1 + venue.sourceAgeMs / venue.maximumSourceAgeMs;
      return (
        normalizedResidual *
        latencyPenalty /
        Math.sqrt(venue.reliability)
      );
    });
    return {
      schemaVersion: 1,
      venues,
      robustAdjustedComposite: composite,
      compositeConfidence:
        included.length >= input.minimumVenueCount
          ? Math.min(1, totalWeight / Object.keys(this.configs).length)
          : 0,
      availableVenueCount: included.length,
      disagreementStatistic:
        residuals.length > 0 ? Math.max(...residuals) : null,
      disagreementMethod: "basis-volatility-latency-reliability-v1",
    };
  }
}
