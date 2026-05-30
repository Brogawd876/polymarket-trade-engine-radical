# Phase 8H Zero Fill Evidence Diagnostic

## Executive Verdict

**Zero fill evidence is mixed causes.**

For the current late-entry paired corpus, `unavailable_no_fills` is correct: Strategy Lab derives `eligibleFillCount = 0` for late-entry because the replayed strategy produced no fill telemetry. Two clean replay logs also contain no raw `order`, `decision_feature`, `ORDER_INTENT`, or `ORDER_LIFECYCLE` records.

There are two additional defects/limits that matter before this corpus can support profit evaluation:

1. **Raw L2 trade-through insufficiency:** every raw L2 file has `market_trade = 0`. Book and `last_trade_price` events exist, but conservative trade-through evidence cannot be produced without `market_trade`.
2. **Runner/replay mapping defect for active Strategy Lab variants:** replay mode uses synthetic token IDs (`replay-up`, `replay-down`) while paired raw L2 uses real CLOB token IDs. Active variants can produce fills, but the scorer cannot match those fills to raw L2 events, so they become `unknown_insufficient_data`.
3. **Runner data-mutation defect:** Strategy Lab replay can append generated replay output back into `logs/early-bird-<slug>.log`, because `engine/logger.ts` appends to slug-derived log paths. Re-running Strategy Lab contaminated two source replay logs and made them fail pair coverage on re-validation.

## Starting Verification

- Starting `master` HEAD: `34e4bef39e78e0c8c4c100c35586c9a40b046f12`
- `origin/master` HEAD: `34e4bef39e78e0c8c4c100c35586c9a40b046f12`
- Working branch: `feat/paired-corpus-zero-fill-diagnostics`
- Initial worktree: clean except untracked `data/`

## Pair Inventory

Phase 8G manifest inventory before this diagnostic run:

| Slug | Replay events | Raw L2 events | Book events | Trade events | Phase 8G validity | Phase 8G SL verdict | eligibleFillCount | evaluatedFillCount | usableEvidenceCount |
|---|---:|---:|---:|---:|---|---|---:|---:|---:|
| btc-updown-5m-1779343200 | 2130 | 182549 | 174397 | 0 | skipped old-schema | unavailable_no_fills | 0 | 0 | 0 |
| btc-updown-5m-1779371700 | 1926 | 187475 | 171276 | 0 | valid | unavailable_no_fills | 0 | 0 | 0 |
| btc-updown-5m-1779372300 | 2638 | 141187 | 130092 | 0 | valid | unavailable_no_fills | 0 | 0 | 0 |
| btc-updown-5m-1779372900 | 2643 | 119894 | 110114 | 0 | valid | unavailable_no_fills | 0 | 0 | 0 |

Current on-disk re-validation after Strategy Lab replay output was appended to two logs:

| Slug | Current replay events | Raw L2 events | Book events | Trade events | Current validity | Current coverage | Current SL verdict |
|---|---:|---:|---:|---:|---|---|---|
| btc-updown-5m-1779343200 | 2130 | 182549 | 174397 | 0 | valid | complete | unavailable_no_fills |
| btc-updown-5m-1779371700 | 9545 | 187475 | 171276 | 0 | invalid | partial | unavailable_no_fills |
| btc-updown-5m-1779372300 | 7585 | 141187 | 130092 | 0 | invalid | partial | unavailable_no_fills |
| btc-updown-5m-1779372900 | 2643 | 119894 | 110114 | 0 | valid | complete | unavailable_no_fills |

## Replay Telemetry Findings

Clean replay logs:

| Slug | Replay order events | Replay fill events | Decision feature intents | tokenId fields | intentId fields | placement timestamps | Conservative reason |
|---|---:|---:|---:|---:|---:|---:|---|
| btc-updown-5m-1779343200 | 0 | 0 | 0 | 0 | 0 | 0 | no_replay_fill_events |
| btc-updown-5m-1779372900 | 0 | 0 | 0 | 0 | 0 | 0 | no_replay_fill_events |

Contaminated replay logs now contain appended `fair-value-maker` replay output:

| Slug | Appended strategy | Replay order events | Replay fill events | Decision feature intents | Blocked decisions | tokenId fields | intentId fields | placement timestamps | Conservative reason |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| btc-updown-5m-1779371700 | fair-value-maker | 593 | 25 | 680 | 419 | 0 | 680 | 0 | fills_or_intents_lack_token_id_mapping |
| btc-updown-5m-1779372300 | fair-value-maker | 378 | 16 | 458 | 218 | 0 | 458 | 0 | fills_or_intents_lack_token_id_mapping |

Important distinction: Strategy Lab uses runtime telemetry emitted during replay, not the raw replay log's `decision_feature` records, to build `ORDER_INTENT` and `ORDER_LIFECYCLE`. The clean late-entry runs still produce no eligible fills. The appended fair-value-maker records demonstrate that the source replay files are mutable under Strategy Lab execution and should not be reused as immutable corpus inputs after such a run.

## Raw L2 Findings

| Slug | Book snapshots | Book deltas | last_trade_price | raw_market_message | market_trade | unique tokenIds | Slug coverage |
|---|---:|---:|---:|---:|---:|---:|---|
| btc-updown-5m-1779343200 | 4576 | 169821 | 2139 | 6010 | 0 | 2 | matches requested slug; raw messages have no slug |
| btc-updown-5m-1779371700 | 10048 | 161228 | 4675 | 11521 | 0 | 2 | matches requested slug; raw messages have no slug |
| btc-updown-5m-1779372300 | 6768 | 123324 | 3168 | 7924 | 0 | 2 | matches requested slug; raw messages have no slug |
| btc-updown-5m-1779372900 | 5962 | 104152 | 2839 | 6938 | 0 | 2 | matches requested slug; raw messages have no slug |

Raw L2 is enough to support book touch and token-side markout reference if a scored order has the real CLOB token ID. It is not enough to produce trade-through evidence because every capture has zero `market_trade` events. `last_trade_price` is intentionally ignored by the current scorer.

## Strategy Lab Paired-Corpus Run

Command:

```bash
bun scripts/run-strategy-lab-paired-corpus.ts --pairs data/pairs --timeout-ms 180000 --variants late-entry late-entry-flow-aware fair-value-maker
```

Result:

- Status: completed
- Completed runs: 6 / 6
- Scope actually run: 2 currently valid pairs x 3 variants
- `l2Files` mapping accepted: yes. Fair-value-maker evaluated 31 candidate fills against raw L2, proving the L2 files were loaded.

Per-variant evidence:

| Variant | PnL | Trade runs | Usable / evaluated fills | Evidence verdict |
|---|---:|---:|---:|---|
| late-entry default | 0.00 | 0 | 0 / 0 | unavailable_no_fills |
| late-entry flow-aware | 0.00 | 0 | 0 / 0 | unavailable_no_fills |
| fair-value-maker | 9.25 | 2 | 0 / 31 | unavailable_insufficient_data / token mismatch path |

The fair-value-maker PnL is not profit evidence. It came from replay simulation over a tiny and partially contaminated corpus and has zero usable conservative fill evidence.

## Root Cause

The current valid late-entry pairs report `unavailable_no_fills` because Strategy Lab has no eligible fill events to score. This is expected late-entry behavior on these captures, not a conservative scorer bug.

The broader Phase 8H diagnosis found two necessary fixes before paired corpus execution can be trusted end to end:

1. **Protect corpus inputs from Strategy Lab mutation.** Replay lab runs must not append generated strategy output to `logs/early-bird-<slug>.log`. Redirect replay logging to a temp path or disable slug-file market logging during Strategy Lab.
2. **Preserve real token IDs in replay metadata.** `ReplayVenueAdapter` defaults to `["replay-up", "replay-down"]`; paired raw L2 uses actual CLOB token IDs. Strategy Lab paired execution should load token IDs from the pair/raw L2 `market_resolved_for_recording` event or manifest metadata and pass them as replay venue metadata so scorer token matching can work.

## Next Technical Recommendation

Do this next, in order:

1. Patch Strategy Lab replay execution so it never appends to source replay logs.
2. Extend pair manifests or Strategy Lab paired loading to pass actual `clobTokenIds` into replay venue metadata.
3. Add a synthetic fill-bearing paired fixture that includes real token IDs and at least one `market_trade`, proving the conservative scorer path can reach `trade_through_fill`.
4. Capture a larger corpus with a benchmark strategy that is active enough for evaluation, while still not tuning ranking weights.

## Profit Relevance

This phase does not say the bot can or cannot make money. It says the current late-entry paired corpus is not yet profit evidence because there are no eligible late-entry fills, no raw public `market_trade` events, and active replay variants cannot yet map replay token IDs to raw L2 token IDs. Profit work should stay blocked until conservative fill evidence exists and survives holdout evaluation.

## Verification

- `bun run check`: passed
- `bun test --max-concurrency=1 test/engine/paired-corpus.test.ts`: passed, 4 tests
- `bun test --max-concurrency=1 test/engine/paired-l2.test.ts`: passed, 12 tests

