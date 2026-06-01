export type MarketTruthClass =
  | "settlement_truth"
  | "own_fill_truth"
  | "venue_state"
  | "predictive_input"
  | "derived_signal"
  | "inferred_diagnostic"
  | "replay_fixture"
  | "mock"
  | "unknown";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface TruthSource {
  sourceClass: MarketTruthClass;
  confidence: ConfidenceLevel;
}
