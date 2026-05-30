# Phase 4: Event-Driven Strategy Replay

## Summary

Phase 4 was repaired after the initial implementation only exposed names without the intended behavior. The repaired goal is to reduce replay dependence on fixed strategy polling, expose deterministic per-token inventory reads, and provide a real gated native modify path without silently falling back to cancel/repost in live mode.

## Implemented Capabilities

### `ctx.onTick(callback)`

`MarketLifecycle` now exposes optional `onTick` registration through `StrategyContext`. Registered callbacks are awaited only for replay/live data changes, plus one initial ready callback after strategy registration if the data sources are already primed.

Fallback, deadline, timer, and shutdown ticks still let lifecycle deadlines and drains progress, but they do not fire strategy `onTick` callbacks.

### `ctx.position(tokenId)`

`MarketLifecycle` now computes filled inventory from `_orderHistory`.

Rules:

- buy fills add shares
- sell fills subtract shares
- pending orders are not included

This gives strategies a deterministic inventory read aligned with simulated exchange accounting.

### `ctx.modifyOrder(orderId, updates)`

`modifyOrder` is wired when the client reports native/sim modify support.

Live behavior:

- disabled by default
- requires `POLY_NATIVE_MODIFY_ENABLED=true`
- requires `POLY_US_ACCESS_KEY` and `POLY_US_SECRET_KEY`
- posts once to `POLY_US_API_HOST` `/v1/order/{orderId}/modify`
- signs the exact `timestamp + method + path` payload with Ed25519
- never falls back to cancel/repost on failure

Sim/replay behavior:

- mutates the pending order in place
- relocks reservation accounting under the same order id
- rejects matched/mined/missing orders

## Strategy Migration

### `fair-value-maker`

- Prefers `ctx.onTick`.
- Falls back to the existing 1s interval when `onTick` is absent.
- Uses `ctx.position(upTokenId)` when available.
- Awaits `ctx.modifyOrder` when available for existing quote price/size changes.
- Does not post a replacement after successful native/sim modify.
- Preserves cancel-and-post fallback only when `modifyOrder` is absent.
- Logs and keeps the pending quote tracked when native modify fails.

### `late-entry`

- Prefers `ctx.onTick`.
- Falls back to the existing interval loop when `onTick` is absent.
- Uses `ctx.position` only to reconcile held shares after fills.
- Does not add trailing stops or automatic GTC exits.
- Adds a one-shot slot deadline timer when `onTick` exists so no-entry cases can release their strategy hold without polling.

## Replay Fixes

- `EarlyBird.nextReplayDeadlineMs()` ignores deadlines `<= nowMs`.
- `VirtualClock.nextTimerMs()` only returns future timers.
- `VirtualClock` rejects non-finite target times and timer delays.
- `ReplayRunner` targets the next replay event, virtual timer, replay deadline, or a 1s fallback tick.
- `ReplayRunner` labels tick reasons as `data`, `timer`, `deadline`, `fallback`, or `shutdown`.
- `ReplayRunner` calls `tickOnce({ kind: "data" })` immediately after priming and after replay events are dispatched.
- Strategy `onTick` callbacks only run for `data` ticks or live dirty-data drains.
- Replay lifecycles receive the slot window from the replay log. This fixes synthetic fixtures whose slugs are descriptive, such as `btc-updown-5m-synthetic-stale-feed`, and cannot be parsed as timestamp slugs.
- `SimUserChannel` fill polling is lazy and only active while orders are tracked.

## Root Cause Recovered From Antigravity Stall

The synthetic fixture deadlock was not caused by `ReplayOrderBook.isReady()` decaying with virtual time. The real failure path was:

1. Synthetic replay slugs did not end with a numeric timestamp.
2. `slotFromSlug()` returned `NaN` slot times for those slugs.
3. `simulationStrategy` scheduled timers from `NaN` slot timing.
4. `VirtualClock.nextTimerMs()` surfaced `NaN`, causing replay time to become `NaN` and spin.

The fix was to use replay log slot windows for replay lifecycles and add non-finite clock validation.

## Validation

Passed:

```powershell
bun run check
bun test test/engine/client-modify-order.test.ts test/engine/replay.test.ts test/engine/market-lifecycle.test.ts test/engine/strategies.test.ts test/engine/late-entry-strategy.test.ts
bun test test/engine/replay-fixtures.test.ts test/engine/replay.test.ts
bun test test/engine
```

Full engine suite result:

- 352 pass
- 0 fail
- 1063 expect calls
- 56 files

## Residual Risk

- Native live modify was unit-tested with mocked fetch/auth inputs, not with real Polymarket US credentials.
- Keep `POLY_NATIVE_MODIFY_ENABLED` off until a controlled live-auth dry run verifies the configured endpoint and credentials.
- Existing adjacent operator cockpit/corpus-summary changes remain uncommitted and should be separated from the Phase 4 commit.
