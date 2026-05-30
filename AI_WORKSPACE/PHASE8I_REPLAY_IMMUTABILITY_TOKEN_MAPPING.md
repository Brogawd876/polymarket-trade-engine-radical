# Phase 8I Replay Immutability and Token Mapping Repair

## Executive Verdict

Phase 8I is a pipeline repair checkpoint. Strategy Lab paired replay is now immutable-safe for source replay fixtures, and paired runs can inject real CLOB token IDs from raw L2 metadata into replay venue metadata.

This does not tune any strategy, change ranking weights, change readiness gates, place live trades, or prove profitability.

## Mutation Bug Fixed

Phase 8H found that Strategy Lab replay could append generated market logger output back into source files such as `logs/early-bird-<slug>.log`.

Fix:

- `Logger` now supports `disabled` mode.
- `MarketLifecycle` accepts `marketLogMode: "normal" | "disabled"`.
- `EarlyBirdRuntimeOptions` carries `marketLogMode`.
- `StrategyLabBatchManager` runs replay batches with `marketLogMode: "disabled"`.

Normal runtime behavior remains unchanged because the default mode is `normal`.

Acceptance result:

- `test/engine/replay-immutability.test.ts` copies a replay fixture, runs Strategy Lab, and asserts the source fixture contents and byte size are unchanged.
- Current valid corpus replay hashes also remained unchanged after paired Strategy Lab reruns.

## Token Mapping Source

Added `extractClobTokenIdsFromRawL2(rawL2Path)` in `engine/replay/paired-token-mapping.ts`.

Token extraction rules:

- Prefer ordered `payload.clobTokenIds` from raw L2 recorder metadata, emitted by `market_resolved_for_recording`.
- Fall back to side-labeled raw L2 events when exactly one `UP` token and exactly one `DOWN` token are present.
- Recognize `tokenId`, `asset_id`, and `assetId` on both top-level event objects and payloads.

Ambiguity behavior:

- No token IDs: `token_mapping_missing`.
- Unlabeled or conflicting token IDs: `token_mapping_ambiguous`.
- Strategy Lab only injects replay venue metadata when extraction is `ok`; otherwise it fails closed and records the token-mapping reason on eligible-fill runs.

## Synthetic Fill-Bearing Fixture Result

`test/engine/replay-immutability.test.ts` uses a tiny paired raw L2 fixture with:

- real-like CLOB token IDs: `TOKEN_UP_123`, `TOKEN_DOWN_456`
- a replay fixture that produces a simulated fill
- a raw L2 `market_trade` after placement on `TOKEN_UP_123`

Result:

- `eligibleFillCount > 0`
- `usableEvidenceCount > 0`
- `trade_through_fill > 0`

This proves the conservative evidence path can become usable when replay fills, real token IDs, placement time, and raw L2 trade-through data are all present.

## Current Corpus Rerun Result

Command:

```text
bun scripts/run-strategy-lab-paired-corpus.ts --pairs data/pairs --timeout-ms 180000 --variants late-entry late-entry-flow-aware fair-value-maker
```

Result:

- Completed.
- Valid pairs used: 2 (`btc-updown-5m-1779343200`, `btc-updown-5m-1779372900`).
- Total runs: 6.
- Source replay logs unchanged by SHA-256 and byte size after rerun.
- `l2Files` mapping was accepted.

Evidence summary:

| Variant | Runs | Eligible | Evaluated | Usable | Touch Only | Trade Through | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| late-entry | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| late-entry-flow-aware | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| fair-value-maker | 2 | 31 | 31 | 31 | 31 | 0 | 0 |

Interpretation:

- Late-entry still produced no eligible fills.
- Fair-value-maker now maps fills to real raw L2 token IDs and evaluates them.
- Current live raw L2 still has zero `market_trade` events, so corpus evidence is touch-only, not trade-through.

## What Still Blocks Profit Evaluation

The pipeline can now produce usable evidence in controlled conditions and touch-only evidence on the current active corpus. However, realistic profit evaluation is still blocked by:

- clean late-entry captures having no eligible fills,
- current live raw L2 captures having zero `market_trade` events,
- active benchmark results relying on touch-only evidence unless future captures include `market_trade`,
- current corpus being tiny and partly historically contaminated before this fix.

## Next Exact Recommendation

Phase 8J should collect or construct a cleaner evidence corpus with raw L2 `market_trade` coverage and then rerun paired Strategy Lab under the now-immutable, real-token-mapped pipeline. Do not tune strategy parameters until fill evidence includes trade-through samples from trusted paired inputs.
