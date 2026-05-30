# Phase 8V: Capture Orchestration Fix

## Summary

The background Phase 8T capture run launched on 2026-05-24 was stopped because the corpus loop started producing mostly partial pairs. The usable artifact from that run is:

- `btc-updown-5m-1779638100` - valid, complete coverage, 287,234 raw L2 events, 2,400 trade events.

The later pairs from the same run are diagnostic only because their raw L2 coverage was partial.

## Diagnosis

`scripts/capture-calibration-corpus.ts` incremented `slotOffset` after every attempt. Because `slotOffset` is relative to wall-clock time, each attempt targeted farther future markets instead of consistently targeting the next upcoming market.

This caused the bot replay window and raw L2 recorder window to drift apart, producing partial pair manifests such as:

- `btc-updown-5m-1779639000`
- `btc-updown-5m-1779640200`
- `btc-updown-5m-1779641700`

A second issue was that `scripts/capture-paired-replay-l2.ts` could print `Validation passed!` and exit `0` even when `coverageVerdict` was `partial` and `pairValidity` was `invalid`.

## Fix

- Corpus capture now keeps the configured relative `--slot-offset` stable across attempts.
- Duplicate target artifacts are detected before launching a capture.
- Existing targets are skipped and the wrapper waits for the next slot instead of overwriting manifests or raw logs.
- `--pairs-dir`, `--raw-l2-dir`, and `--invalid-pairs-dir` are supported for clean valid/rejected output separation.
- Paired capture now exits non-zero unless the manifest is complete, valid, and free of parse/validation errors.
- A watchdog timeout protects the corpus wrapper from stuck capture attempts.

## Recommended Command

```powershell
bun scripts/capture-calibration-corpus.ts --target-valid-pairs 25 --max-attempts 40 --slot-offset 1 --pairs-dir data/pairs-clean --invalid-pairs-dir data/pairs-rejected
```

## Safety

No live trading behavior changed. No strategy logic changed. No risk gates changed. No order placement behavior changed.

## Verification

- `bun run check`
- `bun test --max-concurrency=1 test/scripts/capture-calibration-corpus.test.ts test/engine/paired-l2.test.ts test/scripts/audit-capture-quality.test.ts`
- `bun test --max-concurrency=1`
- `bun scripts/capture-calibration-corpus.ts --target-valid-pairs 1 --max-attempts 2 --pairs-dir data/pairs-clean --invalid-pairs-dir data/pairs-rejected`
- `bun scripts/audit-capture-quality.ts --pairs-dir data/pairs-clean`

Smoke result:

- `btc-updown-5m-1779643200` was captured into `data/pairs-clean` with complete coverage and valid pair status.
- Audit result was `capture_quality_warn` only because a single smoke pair has weak temporal spread. It reported 1 valid pair, 0 invalid pairs, 343,156 raw L2 events, and 2,788 raw L2 trade events.

Follow-up capture result:

- A longer 25-pair capture was started after the fix and then intentionally stopped on 2026-05-24.
- The run preserved 5 valid complete pairs in `data/pairs-clean` and 0 rejected manifests in `data/pairs-rejected`.
- Latest audit reported 5 valid pairs, 0 invalid pairs, complete coverage for all 5, 1,707,270 raw L2 events, and 13,316 raw L2 trade events.
- The run exposed a separate strategy/quote hygiene issue: repeated simulated extreme quotes such as `BUY UP @ 0.94`, usually blocked by risk gates. This is not a capture orchestration failure, but corpus expansion is paused until the strategy/shared quote path is audited.

Recommended next work:

- Audit all strategies and shared quote/execution paths, not only the currently active fair-value path.
- Quantify extreme quote rate, duplicate blocked-intent rate, blocked rate, and fill behavior per strategy.
- Add `no quote`/throttling/deduplication rules where appropriate before resuming corpus expansion.
