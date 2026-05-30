# Phase 8O: CalibrationRecord Pre-Trade Feature Enrichment

## Executive Verdict

PASS as an offline calibration data checkpoint.

`CalibrationRecord` now carries decision-time features needed for offline calibration feature comparison. This phase does not modify live execution, live risk gates, order placement, runtime strategy behavior, Strategy Lab ranking weights, or readiness gates.

No profitability claim is made.

## Implementation Summary

- Strategy Lab conservative fill evidence now includes the matched `DecisionFeatureSnapshot` when replay telemetry can map it by `intentId` or `orderId`.
- Calibration extraction flattens decision-time fields onto `CalibrationRecord`.
- Missing decision evidence stays explicit through null fields and `dataQuality.missingReasons`.
- The Phase 8N comparison script now includes the enriched pre-trade fields as default score candidates.

## Added Calibration Fields

- `modelProbability`
- `rawProbability`
- `fairValue`
- `marketImpliedProbability`
- `quotedEdge`
- `fairValueEdge`
- `bestBid`
- `bestAsk`
- `mid`
- `spread`
- `topOfBookLiquidity`
- `timeToCloseMs`
- `volatilityEstimate`
- `predictiveDisagreement`
- `predictiveDivergence`
- `resolutionDistance`
- `distanceToOpenAnchor`
- `action`
- `strategyId`
- `variantId`
- `configHash`
- `quoteTsMs`
- `decisionTsMs`
- `fillTsMs`

## Field Sources

- `modelProbability`, `rawProbability`, and `fairValue` come from the decision snapshot probability, side-adjusted for UP/DOWN.
- `marketImpliedProbability` comes from the quoted order price.
- `quotedEdge` and `fairValueEdge` are derived from side-adjusted fair value and quoted price, with BUY using `fairValue - price` and SELL using `price - fairValue`.
- Book/liquidity fields come from the decision snapshot order book.
- `timeToCloseMs`, volatility, predictive disagreement/divergence, and resolution distance come from the decision snapshot.
- `predictiveDivergence` uses aggregate divergence when present and falls back to predictive-tape divergence from settlement when aggregate divergence is null.

## Missing Value Policy

Nulls are preserved. The extractor does not backfill fake zeros.

New explicit missing reasons include:

- `missing_decision_feature`
- `missing_model_probability`
- `missing_fair_value_edge`

## Local Corpus Rerun

Command:

```bash
bun scripts/run-strategy-lab-paired-corpus.ts --pairs data/pairs --timeout-ms 180000 --variants late-entry late-entry-flow-aware fair-value-maker --out-calibration-jsonl data/reports/phase8o-calibration.jsonl
```

Result:

- valid pairs used: 5
- total Strategy Lab runs: 15
- generated calibration records: 1,050
- late-entry variants: no eligible fills
- fair-value-maker: 70 / 70 usable touch-only fills
- generated JSONL remains uncommitted

## Feature Comparison Rerun

Command:

```bash
bun scripts/compare-offline-calibration-features.ts --input data/reports/phase8o-calibration.jsonl --out-json data/reports/phase8o-calibration-feature-comparison.json
```

Result:

- total records: 1,050
- malformed rows: 0
- train/holdout split: 409 / 176 on labeled filled rows
- missing labels: 465
- minimum train/holdout requirement: 30 / 10

Fields with enough train/holdout samples:

- `modelProbability`
- `rawProbability`
- `fairValue`
- `marketImpliedProbability`
- `quotedEdge`
- `fairValueEdge`
- `spread`
- `bestBid`
- `bestAsk`
- `topOfBookLiquidity`
- `timeToCloseMs`
- `volatilityEstimate`
- `predictiveDivergence`
- `resolutionDistance`
- `distanceToOpenAnchor`

Selected `adverseSelection` holdout metrics:

| score field | train | holdout | missing score | Brier | log loss | ECE | bucket delta | buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelProbability` | 409 | 176 | 15 | 0.016118 | 0.057080 | 0.012175 | 0.012175 | 32 |
| `fairValueEdge` | 409 | 176 | 15 | 0.047594 | 0.174086 | 0.028981 | 0.028981 | 16 |
| `spread` | 409 | 176 | 0 | 0.047822 | 0.188564 | 0.008523 | 0.008523 | 6 |
| `bestBid` | 409 | 176 | 0 | 0.017382 | 0.079339 | 0.020833 | 0.020833 | 15 |
| `bestAsk` | 409 | 176 | 0 | 0.017382 | 0.079339 | 0.020833 | 0.020833 | 15 |
| `topOfBookLiquidity` | 409 | 176 | 0 | 0.048256 | 0.195584 | 0.004411 | 0.011822 | 6 |
| `timeToCloseMs` | 409 | 176 | 0 | 0.017149 | 0.072733 | 0.017984 | 0.017984 | 29 |
| `volatilityEstimate` | 409 | 176 | 0 | 0.048521 | 0.201848 | 0.000208 | 0.000208 | 1 |
| `predictiveDivergence` | 409 | 176 | 0 | 0.045665 | 0.161746 | 0.009834 | 0.009834 | 17 |
| `resolutionDistance` | 409 | 176 | 0 | 0.017018 | 0.082470 | 0.016561 | 0.016561 | 4 |

## Interpretation

The immediate Phase 8N feature sparsity problem is fixed. Calibration comparison can now use actual decision-time predictors.

The current corpus is still not a basis for tuning:

- the labeled subset is only 585 rows,
- holdout is only 176 rows,
- labels are heavily skewed toward adverse selection,
- much of the current evidence is still touch-only rather than trade-through-heavy,
- in-sample and same-corpus holdout metrics can be unstable with this small corpus.

## Profit Relevance

This phase improves the offline evaluation pipeline. It does not prove edge, profitability, maker fill realism, or live readiness. It only makes future calibration studies more meaningful by exposing the features that were actually known at decision time.

## Next Recommendation

Phase 8P should collect a larger clean paired corpus with trade-print-backed evidence and explicit temporal train/holdout separation before any calibration-driven tuning or readiness promotion.
