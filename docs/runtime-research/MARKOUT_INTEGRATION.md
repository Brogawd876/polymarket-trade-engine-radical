# Phase 8B: Strategy Lab Markout Integration

Status: implemented on `feat/strategy-lab-markouts`.

## What Changed

Strategy Lab now computes post-fill token markouts from replay data when replay fixtures contain token-side orderbook observations. The integration is measurement-only: it reports markout fields but does not change strategy ranking or scoring.

Reported horizons:

- `markout_1s`
- `markout_5s`
- `markout_30s`
- `settlement_markout`

Run and summary outputs also include sample counts and unavailable reason counts so missing data is visible instead of silently treated as zero or favorable.

## Definition

For a BUY fill:

`markout = future token reference price - fill price`

For a SELL fill:

`markout = fill price - future token reference price`

For settlement:

- BUY: `payout - fill price`
- SELL: `fill price - payout`

The replay extractor uses token-side orderbook snapshots. BTC ticker or generic market price events are not used as token markout prices.

## Availability Rules

Markouts are unavailable when:

- no fill exists,
- no token-side reference price exists for the filled side,
- no observation exists near the target horizon,
- no settlement direction is present for settlement markout.

Unavailable results remain `null` and carry explicit reasons. They are not backfilled, approximated from BTC price, or converted to zero.

## Current Limits

- Raw L2 recorder is still not implemented.
- Conservative maker fill-model integration is still not wired into Strategy Lab truth.
- Replay fixtures with sparse orderbook snapshots may populate only some horizons.
- Settlement markout requires replay telemetry to include settlement direction.
- No profitability claim exists.

## Next Profit-Relevant Step

Either implement the raw L2 recorder or wire the conservative fill model behind an explicit Strategy Lab option. Raw L2 is the stronger next step if the goal is queue/adverse-selection evidence; conservative fill integration is the stronger next step if the goal is immediately reducing replay optimism.
