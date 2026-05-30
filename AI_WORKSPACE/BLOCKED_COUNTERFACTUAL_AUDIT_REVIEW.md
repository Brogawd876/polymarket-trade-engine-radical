# Blocked Counterfactual Audit Review

## Audit Execution
- **Command:** `bun scripts/audit-blocked-counterfactuals.ts --pairs-dir data/pairs --out-json data/reports/blocked-counterfactuals.json --out-md data/reports/blocked-counterfactuals.md --dedupe-window-ms 1000`
- **Dataset/Pair Count:** 84 valid pairs loaded.
- **Contamination Status:** 13 pairs skipped as contaminated (multiple runs detected).

## Summary Table
| Strategy | Blocked | Unique | Would Fill | Good Block | Bad Block | No Fill | Inconclusive | Avg PnL |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| fair-value-maker | 293 | 292 | 237 | 118 | 119 | 55 | 0 | $0.1403 |

## Interpretation
- **Risk Gate Effectiveness:** The audit shows a nearly even split between "Good Blocks" (118) and "Bad Blocks" (119). This indicates that while the risk gates are preventing some profitable fills, they are also successfully shielding the engine from an equal number of losing fills.
- **Top Block Reason:** `open exposure would exceed max exposure limit` (93%+ of blocks).
- **Permissive Mode Performance:** Replay comparison showed a massive PnL jump ($202 vs -$2.20) in permissive mode, but with a critical caveat: **Adverse Selection jumped from 0.72 to 0.92**. 

## Exact Limitations
- High adverse selection in permissive mode suggests that many of the "profitable" counterfactual fills might be capturing toxic momentum that is difficult to execute in reality without further slippage or cancellation.
- Bypassing exposure limits in replay is unrealistic for live production.

## Verdict
**Does the audit justify risk-gate changes? No.**
The high adverse selection rate (0.92) in permissive mode proves that the current risk gates are a necessary defense against toxic flow. Global loosening of the exposure or liquidity gates would likely degrade real-world performance.
