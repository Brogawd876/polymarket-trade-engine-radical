# Phase 8M: Offline Isotonic Calibration Scaffold

## Verdict

Phase 8M adds an offline-only isotonic calibration scaffold for Phase 8L `CalibrationRecord` JSONL output.

This does not change live execution, live risk gates, order placement, runtime strategy behavior, Strategy Lab ranking weights, or readiness gates. It does not claim profitability.

## What Changed

- Added `engine/replay/isotonic-calibration.ts`
  - Pool-adjacent-violators isotonic regression for binary labels.
  - Duplicate score aggregation before fitting.
  - Monotonic calibrated buckets.
  - Prediction for new scores with edge clamping.
- Added `engine/replay/calibration-metrics.ts`
  - Extracts numeric score and binary label fields from `CalibrationRecord`.
  - Preserves missing/null evidence by dropping invalid rows with explicit counts.
  - Computes Brier score, clipped log loss, and expected calibration error.
  - Returns `insufficient_data` instead of forcing a model when valid samples are below threshold.
- Added `scripts/run-offline-calibration.ts`
  - Reads CalibrationRecord JSONL.
  - Supports `--input`, `--out-json`, `--score-field`, `--label-field`, and `--min-samples`.
  - Prints a compact bucket table.
  - Writes JSON summary only when requested.

## Local Calibration Smoke Result

Command:

```bash
bun scripts/run-offline-calibration.ts --input data/reports/phase8l-calibration.jsonl --out-json data/reports/phase8m-calibration-summary.json
```

Result:

- status: `ok`
- score field: `fillPrice`
- label field: `adverseSelection`
- valid samples: 585
- positive-label rate: 0.948718
- malformed rows: 0
- missing labels dropped: 465
- missing scores: 0
- invalid scores: 0
- invalid labels: 0
- Brier score: 0.021978
- log loss: 0.073611
- ECE: 0.000000
- buckets: 20

Interpretation:

This proves the offline calibration path can consume Phase 8L JSONL and produce a deterministic isotonic table. It is not enough data to claim a tradable edge, and the default `fillPrice -> adverseSelection` mapping is a scaffold smoke test rather than a final production feature choice.

## Data Handling

The calibration code does not fill missing evidence with fake zeros. Missing/null scores or labels are excluded and counted. Input records are not mutated.

Generated local files remain uncommitted:

- `data/reports/phase8l-calibration.jsonl`
- `data/reports/phase8l-smoke.json`
- `data/reports/phase8m-calibration-summary.json`

## Tests

- `bun run check`
- `bun test --max-concurrency=1 test/engine/isotonic-calibration.test.ts test/engine/calibration-metrics.test.ts test/engine/calibration-extractor.test.ts`
- `bun test --max-concurrency=1`

## Next Recommendation

Phase 8N should choose a defensible calibration feature set from real Phase 8L records, likely comparing quote edge, fill price, spread, markout-derived fields, and market-trade evidence quality. Keep this offline until the calibration has enough out-of-sample data to judge whether it improves probability estimates.
