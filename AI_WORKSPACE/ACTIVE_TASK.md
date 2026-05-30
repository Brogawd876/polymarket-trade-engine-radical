# Active Task

**Status:** Engine `master` updated with Phase 9D strategy calibration. 

**Current Objective:** Phase 9E: Dynamic Position Sizing and Confidence Scaling.

## Current Status

The engine is now a hardened research platform with the following status:
- **Strategy Calibration (Phase 9D) COMPLETED**: Implemented strategy-side exposure-aware sizing clamps. Reduced blocked intent noise by >90%.
- **Blocked-Decision Counterfactual Audit**: COMPLETED. Confirmed risk gates are vital defenses.
- **Normal Mode Performance**: `fvm-v1.1.0` is profitable in Normal mode ($41.44 PnL across 50 pairs).
- **Adverse Selection**: Remains high (~0.9), confirming the maker strategy's nature in this regime.

## Completed Steps

- [x] Phase 4: Live feed initialization and timing correctness.
- [x] Phase 5: Multi-round paper/shadow capture.
- [x] Phase 5B: Multi-round replay-artifact capture.
- [x] Phase 6: Historical replay validation.
- [x] Phase 7: Replay-Based Strategy Readiness Audit.
- [x] Phase 8A: Profit-Critical Data Foundation.
- [x] Phase 8B: Strategy Lab Markout Integration.
- [x] Phase 8C: Raw Polymarket L2 Recorder (Hardened).
- [x] Phase 8D: Conservative Fill-Model Scoring.
- [x] Phase 8E/8F: Empirical Calibration Gate and 25-pair corpus expansion.
- [x] Phase 9A: Blocked-decision counterfactual audit.
- [x] Phase 9B: Establish "Repository Truth" and run audit.
- [x] Phase 9C: Verify audit validity and decide next move (Decision: Do not loosen gates).
- [x] Phase 9D: Strategy calibration and noise reduction (Implemented strategy-side clamps).

## Next Exact Task

1. **Tune Confidence Scaling:** Implement logic in `fairValueMaker` to scale `sharePct` based on predictive confidence (sigma) and edge.
2. **Finalize Institutional Variant:** Standardize the variant with maker-safe hygiene and dynamic sizing as the production-ready champion.
3. **Multi-Asset Replay:** Expand validation to other assets (ETH, SOL) if fixtures are available.

---

### A/B Test Findings & Sweep Results (2026-05-27)
Post-Calibration results across 50 corpus fixtures (Phase 9D):

| Strategy / Variant | PnL | Trades | ASR | Blocked Intents | Status |
|--------------------|-----|--------|-----|-----------------|--------|
| `fvm-v1.1.0` (Clamped) | **+$41.44** | 21 | 91.2% | 82 | **Champion / Hardened** |
| `fvm-v1.1.0` (Baseline) | **-$2.20** | 7 | 72.2% | 1383 | Deprecated (Noisy) |

**Verdict**: 
1. **Strategy-side clamping is effective**: 94% reduction in blocked intent noise.
2. **Profitability restored in Normal mode**: Clamping allows the strategy to capture more usable fills by scaling down rather than hitting hard rejections.
3. **Risk Gates are Unchanged**: Security posture remains strict.
