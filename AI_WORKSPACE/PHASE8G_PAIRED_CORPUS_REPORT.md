# Phase 8G/8F Paired Corpus Report

## Aggregate Counts

Source: `data/calibration-run-final-25/corpus-summary.json`.

- **Total manifests scanned:** 32
- **Valid pairs:** 25
- **Invalid pairs:** 7
- **Complete coverage count:** 25
- **Total raw L2 trade events:** 57,605
- **Calibration records:** 27,498
- **Labeled records:** 23,523
- **Trade-print-backed records:** 23,523
- **Touch-only records:** 3,975
- **Global adverse-selection rate:** 92.55%
- **Approximate temporal span:** 135.92 hours

## Strategy Lab Final Run

- **Status:** completed
- **Total runs:** 75
- **Completed:** 75
- **Failed:** 0
- **Canceled:** 0
- **Variants:** `late-entry`, `late-entry-flow-aware`, `fair-value-maker`
- **Readiness decision:** BLOCKED
- **Paper candidates:** 0

## Strategy Summary

| Strategy | Runs | Trade Rate | Total PnL | Avg PnL | Best | Worst | Key Finding |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `late-entry` | 25 | 0% | $0.00 | $0.00 | $0.00 | $0.00 | No trades fired. |
| `late-entry-flow-aware` | 25 | 0% | $0.00 | $0.00 | $0.00 | $0.00 | No trades fired. |
| `fair-value-maker` | 25 | 100% | -$48.40 | -$1.936 | +$26.55 | -$34.45 | Active but heavily adverse-selected. |

## Fair-Value-Maker Execution Diagnostics

- Conservative fill samples: 478
- Trade-through fills: 409
- Touch-only fills: 69
- Conservative adverse-selection rate: 94.15%
- Conservative 1s markout: -0.0531
- Conservative 5s markout: -0.0569
- Conservative 30s markout: -0.0518
- Average turnover: $48.67
- Blocked decisions: 1,848
- Problems flagged: 1,017

## Interpretation

- The paired replay/L2 evaluation machinery is now useful and reproducible.
- The final corpus is large enough to expose strategy and risk-gate behavior, but not enough to pass strict readiness gates.
- `fair-value-maker` remains vulnerable to toxic fills and adverse selection.
- The late-entry variants are not producing fills under the current execution model.
- More paper/shadow collection should wait until quote hygiene and blocked-decision counterfactuals are implemented.

## Next Recommendation

Add a blocked-decision counterfactual audit and quote-hygiene pass before more corpus expansion:

- Score blocked decisions using realistic maker/taker execution assumptions.
- Compare normal Strategy Lab behavior against a replay-only permissive/selective risk mode.
- Prevent saturated probabilities, negative quote candidates, and repeated blocked-intent spam from polluting future calibration data.

No profitability claim. No paper-candidate claim. No live trading behavior changed.
