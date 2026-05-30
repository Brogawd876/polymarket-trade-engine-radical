# Paired Replay + Raw L2 Dataset Capture

This document outlines the usage, artifacts, and safety boundaries for the Paired Replay + Raw L2 Capture script (`scripts/capture-paired-replay-l2.ts`).

## Overview

The paired capture script is designed to run the trading bot runtime (in shadow/paper mode) while simultaneously recording raw Level 2 Orderbook and Trade events from the Polymarket websocket feed. This generates perfectly synchronized datasets used to validate conservative fill scoring in Strategy Lab without relying on synthetic mocks.

## Command

```bash
bun scripts/capture-paired-replay-l2.ts --strategy <strategy-name> --rounds 1 --slot-offset <offset> [--always-log]
```

### Example
```bash
bun scripts/capture-paired-replay-l2.ts --strategy late-entry --rounds 1 --slot-offset 1 --always-log
```

## Output Artifacts

Running a successful capture generates three key artifacts:

1. **Replay Log**: `logs/early-bird-<slug>.log`
   Contains the state execution, intent outputs, and runtime telemetry.
2. **Raw L2 Log**: `data/raw-l2/raw-l2-<slug>.ndjson`
   Contains the raw `market_book_snapshot`, `market_book_delta`, and `market_trade` events wrapped in NDJSON envelopes.
3. **Pair Manifest**: `data/pairs/<slug>.pair.json`
   Contains metadata about the capture run, coverage bounds, parsing results, and validation verdicts.

## Pair Manifest Fields

- `slug`: The deterministic ID of the captured slot (e.g., `btc-updown-5m-1234567890`).
- `replayLogPath`: Path to the runtime log.
- `rawL2LogPath`: Path to the raw L2 log.
- `coverageVerdict`: `"complete" | "partial" | "missing"`. Valid pairs must be "complete" (L2 data must strictly lead and tail the replay events).
- `pairValidity`: `"valid" | "invalid"`. Tracks if the pair passed basic checks, coverage bounds, and Strategy Lab evaluation without internal execution failure. No-fill runs can still be marked valid.
- `strategyLabEvidenceVerdict`: Evaluates whether Strategy Lab was able to use the capture (`usable`, `unavailable_no_fills`, `unavailable_insufficient_data`, etc).

## Strategy Lab Replay Safety

Phase 8I made paired Strategy Lab replay input-only for source replay logs.

When `StrategyLabBatchManager` runs a replay fixture, it disables per-market slug file logging through `marketLogMode: "disabled"`. Generated runtime output must not be appended to the source `logs/early-bird-<slug>.log` file that is being replayed. Normal capture/runtime logging defaults remain unchanged.

For paired runs with `l2Files`, Strategy Lab also extracts real CLOB token IDs from the paired raw L2 file and passes them into replay venue metadata. This prevents replay fills from using synthetic `replay-up` / `replay-down` token IDs when raw L2 evidence uses real token IDs.

Token mapping source order:

1. Ordered raw L2 recorder metadata (`payload.clobTokenIds` on `market_resolved_for_recording`).
2. Exactly one side-labeled `UP` token and exactly one side-labeled `DOWN` token from raw L2 events.

If ordering is missing or ambiguous, the mapping fails closed as `token_mapping_missing` or `token_mapping_ambiguous`.

## Trade-Print Capture Semantics

Phase 8J confirmed that Polymarket market WebSocket `last_trade_price` messages are the public trade-print source for BTC 5-minute captures when complete.

The raw L2 recorder now writes:

- `last_trade_price` for every last-trade message, preserving weak reference data.
- `market_trade` in addition to `last_trade_price` only when the message includes token ID, finite price, finite size, and finite source timestamp.

This means fresh paired captures can contain trade-through evidence. Older captures that only contain normalized `last_trade_price` and zero `market_trade` remain book-touch/weak-reference datasets and should not be used to claim realistic maker fill quality.

Current source hierarchy:

| Tier | Source | Use |
|---|---|---|
| 1 | Market WebSocket complete `last_trade_price` normalized as `market_trade` | Conservative trade-through evidence |
| 2 | Authenticated user fills | Own fill audit only |
| 3 | CLOB last-trade-price snapshot or incomplete last-trade data | Weak reference, not trade-through proof |
| 4 | Book touch | Touch-only evidence |

## Safety Restrictions & Boundaries

- **No Live Trading**: The orchestrator absolutely forbids using `--prod`, `--live`, or matching environment variables. It enforces `NODE_ENV=development` and fail-closes if it detects live flags.
- **Credential-Free Recorder**: The L2 recorder process does not load or access private keys, avoiding potential security leaks.
- **No Profitability Claims**: The capture and scoring mechanism does not assert trading profitability. It purely evaluates the fidelity and conservativeness of the execution model relative to raw L2 data.
- **Strategy Lab Validation**: The paired manifest integrates with `StrategyLabBatchManager` to ensure that raw evidence maps securely without granting phantom/optimistic fills.

## Validating Existing Pairs

To manually re-validate a capture pair without running a new capture:
```bash
bun scripts/validate-paired-l2.ts --pair data/pairs/<slug>.pair.json
```
