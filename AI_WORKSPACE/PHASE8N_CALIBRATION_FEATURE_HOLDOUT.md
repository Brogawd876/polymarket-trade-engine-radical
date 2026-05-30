# Phase 8N: Offline Calibration Feature Comparison and Holdout Validation

## Verdict

Phase 8N adds offline train/holdout calibration feature comparison for Phase 8L/8M `CalibrationRecord` JSONL data.

This remains offline-only. It does not change live execution, live risk gates, order placement, runtime strategy behavior, Strategy Lab ranking weights, readiness gates, or profitability claims.

## What Changed

- Added `engine/replay/calibration-feature-comparison.ts`.
  - Compares multiple candidate score fields against multiple labels.
  - Derives markout labels without filling missing evidence.
  - Uses deterministic train/holdout separation.
  - Fits isotonic only on train samples and evaluates on holdout samples.
  - Reports sample counts, missing/invalid counts, positive-label rates, Brier score, log loss, ECE, bucket counts, and train/holdout bucket stability.
  - Flags post-outcome markout score fields as leakage/not-pre-trade features.
- Added `scripts/compare-offline-calibration-features.ts`.
  - Reads Phase 8L CalibrationRecord JSONL.
  - Supports score-field and label-field CSVs, train ratio, minimum train samples, minimum holdout samples, and optional JSON output.
- Added `test/engine/calibration-feature-comparison.test.ts`.

## Local Run

Command:

```bash
bun scripts/compare-offline-calibration-features.ts --input data/reports/phase8l-calibration.jsonl --out-json data/reports/phase8n-calibration-feature-comparison.json
```

Dataset:

- total records: 1,050
- malformed rows: 0
- deterministic split: 70% train / 30% holdout
- minimum required train/holdout samples: 30 / 10

## Key Results

`fillPrice` is the only non-markout default score field with enough samples. `spread` and `predictedProbability` are missing in the current JSONL, so they are reported as insufficient data.

| Score | Label | Status | Train | Holdout | Positive Rate | Holdout Brier | Holdout Log Loss | Holdout ECE | Bucket Delta | Buckets |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `fillPrice` | `adverseSelection` | ok | 409 | 176 | 0.948718 | 0.015955 | 0.057985 | 0.010227 | 0.010227 | 20 |
| `fillPrice` | `profitableMarkout1s` | ok | 409 | 176 | 0.051282 | 0.048521 | 0.201848 | 0.000208 | 0.000208 | 1 |
| `fillPrice` | `profitableMarkout5s` | ok | 409 | 176 | 0.102564 | 0.078578 | 0.294728 | 0.024797 | 0.024797 | 1 |
| `fillPrice` | `profitableMarkout30s` | ok | 409 | 176 | 0.153846 | 0.096750 | 0.346767 | 0.071591 | 0.071591 | 2 |
| `fillPrice` | `adverseMarkout5s` | ok | 409 | 176 | 0.897436 | 0.040994 | 0.121068 | 0.023244 | 0.023244 | 18 |
| `spread` | all default labels | insufficient_data | 0 | 0 | N/A | N/A | N/A | N/A | N/A | 0 |
| `predictedProbability` | all default labels | insufficient_data | 0 | 0 | N/A | N/A | N/A | N/A | N/A | 0 |

Markout score fields (`markout1s`, `markout5s`, `markout30s`) are reported but flagged:

- `post_outcome_feature_not_pre_trade` when they are post-outcome features.
- `post_outcome_leakage_same_markout_horizon` when the score directly encodes the same markout horizon as the label.

Perfect holdout metrics for same-horizon markout score/label pairs are leakage checks, not useful predictive calibration.

## Missing Evidence

For label families using adverse selection or markouts:

- valid records: 585
- missing score count for `fillPrice`: 0
- missing label count: 465

For `spread` and `predictedProbability`:

- valid records: 0
- missing score count: 1,050
- these fields cannot currently support calibration.

## Interpretation

This phase proves the offline comparison harness works and prevents in-sample calibration from being mistaken for model quality. The current corpus is still too narrow for strategy tuning:

- The adverse-selection base rate is extremely high in the available labeled records.
- `fillPrice` has enough rows for holdout scoring but is only a crude feature.
- Better pre-trade score fields such as quoted edge, spread, market-implied probability, and model probability are currently missing or null in the Phase 8L JSONL.
- Markout-derived score fields are useful diagnostics but not deployable pre-trade features.

## Generated Artifacts

Generated locally and left uncommitted:

- `data/reports/phase8n-calibration-feature-comparison.json`

## Next Recommendation

Phase 8O should enrich `CalibrationRecord` with true pre-trade fields already known at decision time, such as quoted edge, fair-value edge, market-implied probability, model probability, spread, and liquidity/depth. Then rerun this holdout comparison before any strategy tuning or readiness changes.
