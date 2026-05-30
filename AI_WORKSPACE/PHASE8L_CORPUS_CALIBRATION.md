# Phase 8L Report: Corpus Calibration Infrastructure

## 1. Executive Verdict: PASS

Phase 8L successfully built the offline corpus expansion and calibration data layer. It allows Strategy Lab to run across multiple paired manifestations and extract individual fill evaluations into a standardized calibration schema without modifying live execution logic.

## 2. What was implemented

- **Corpus Expansion Harness:** Modified `scripts/run-strategy-lab-paired-corpus.ts` to seamlessly process entire directories of paired corpus manifests or distinct pairs via `--pairs-dir` and `--pair`. The harness correctly buckets valid and invalid pairs and generates aggregated metrics.
- **Offline Evidence Support:** Safely extended the downstream Strategy Lab reporting via `ConservativeFillEvidencePoint` to expose per-fill `1s`, `5s`, `30s` markouts and adverse selection flags directly derived from L2 evidence, avoiding re-evaluation.
- **Calibration Record Schema:** Implemented `engine/replay/calibration-extractor.ts` to map offline strategy variant results into a flat, well-structured `CalibrationRecord`. This cleanly maps token identifiers, quote and fill timestamps, prices, and markouts while rigorously checking and appending `missingReasons` when data is unavailable.
- **Data Preservation:** The system explicitly guards against faking profitability or backfilling data; it outputs explicitly bounded records for downstream Platt scaling or isotonic calibration models.

## 3. Manual Smoke Result
- Executed successfully via `bun scripts/run-strategy-lab-paired-corpus.ts --pairs-dir data/pairs --out-json data/reports/phase8l-smoke.json --out-calibration-jsonl data/reports/phase8l-calibration.jsonl`.
- Successfully validated pairs and processed them without mutations.
- The `phase8l-smoke.json` and `phase8l-calibration.jsonl` were generated locally as intended and remain untracked.

## 4. Source Immutability Check

- **Unchanged:** YES. The batch runner strictly loads from existing `.pair.json` records and source logs, projecting the results outward to JSON and JSONL datasets.

## 5. Profit Relevance

- **What this improves:** This builds the explicit foundational layer to move from measuring loss to *fixing loss*. By outputting the `CalibrationRecord`, we now have the structured offline dataset required to measure feature divergence and calibrate probability outputs without making wild guesses.
- **What this does not prove:** This does *not* prove that the strategy is profitable, nor does it alter readiness gates. The system is deliberately kept separated from live execution logic.

## 6. Next Recommendation

**Proceed to Calibration Modeling:**
Now that offline calibration dataset extraction is available and the corpus summary is available, the system is ready to collect more data and subsequently build the isotonic regression/Platt scaling models to correct the predicted probabilities against the proven adverse selection rate.
