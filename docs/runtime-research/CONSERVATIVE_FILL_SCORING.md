# Conservative Fill Scoring

## Overview

`engine/replay/fill-scoring.ts` implements `ConservativeFillScorer`, a module that
evaluates whether a simulated maker order would realistically have been filled based
on a stream of raw L2 and trade events recorded from the Polymarket CLOB.

This module exists because maker strategies can appear profitable in replay while
failing in live trading when replay assumes fills too easily.

---

## What the Conservative Fill Scorer Does

Given:
- An order intent (`tokenId`, `action`, `side`, `price`, `shares`, `placedTsMs`, optional `queuePosition`).
- A sequence of `ProfitEventEnvelope` records (from the NDJSON event store or raw L2 recorder).

The scorer returns a `FillScoreResult` containing:

| Field | Description |
|---|---|
| `verdict` | Classification: `no_fill`, `touch_only`, `trade_through_fill`, `probable_fill`, or `unknown_insufficient_data` |
| `reason` | Plain-text explanation for the verdict |
| `fillProbability` | Numeric probability 0–1 |
| `adverseSelection` | `true` if short-horizon markouts are negative; `null` if unavailable |
| `fillTsMs` | Timestamp of the inferred fill event; `null` if no fill |
| `markouts` | 1s / 5s / 30s / settlement signed markouts (token price, not BTC spot) |
| `markoutReasons` | Reason string for each unavailable markout horizon |

---

## Classification Logic

### `trade_through_fill`
A public `market_trade` event is observed at a price that crosses our resting order
price (e.g., we are resting a BUY at 0.50 and a trade occurs at 0.49 or lower, or we
are resting a SELL at 0.60 and a trade occurs at 0.61 or higher).

This is the **strongest** evidence of a realistic fill. It means the market moved
through our queue position.

### `probable_fill`
A `market_trade` occurs at exactly our price, and the cumulative traded volume at that
price level exceeds our estimated `queuePosition + shares`. This means enough volume
traded at our price to cover our queue position and our order.

**This requires a known `queuePosition`.** If queue position is unknown (`null` or
not provided), this classification is never reached — the scorer falls back to
`touch_only` if a book touch occurred.

### `touch_only`
The book state shows our resting price was reached by the **same side we are resting on**, but no trade-through evidence exists and queue satisfaction cannot be confirmed.

**Correct maker-side touch semantics:**
- **maker BUY at P**: we are resting on the **bid** side. Touch occurs when `bestBid >= P` (the bid queue has moved up to our price level, meaning an aggressor could hit us).
- **maker SELL at P**: we are resting on the **ask** side. Touch occurs when `bestAsk <= P` (the ask queue has dropped down to our price level).

> **Important:** The opposite side (ask for BUY, bid for SELL) reaching our price is a **taker** crossing, not a maker touch. Using the ask to detect a maker-BUY touch would be inverted logic.

### `no_fill`
Relevant events for the correct `tokenId` were observed after placement, but the
price never reached the resting level.

### `unknown_insufficient_data`
No relevant events were found for the correct `tokenId` and `placedTsMs`. The event
stream is insufficient to make any determination.

---

## Conservative Defaults

| Situation | Behavior |
|---|---|
| Book touch alone | Not a fill — classified as `touch_only` |
| Unknown queue position | `queuePosition` treated as `Infinity`; exact-price trades can never satisfy the queue threshold |
| Missing `market_trade` evidence | Does not create a fill verdict |
| `last_trade_price` event | **v1: ignored entirely** — not used for fill evidence or markout reference. Only `market_book_snapshot`/`market_book_delta` supply markout reference prices. |
| Events before `placedTsMs` | Ignored — pre-placement market activity does not affect fill scoring |
| Events for wrong `tokenId` | Ignored — token mismatch is fully filtered |
| Out-of-order events | Sorted by `processedTsMs` before processing |
| Missing future price reference | Markout returns `null` with explicit reason; never returns optimistic fake values |

---

## Markout Semantics

Markouts measure **token contract price movement** after a fill, not BTC spot price.

Signing convention:
- **Buy**: `futureTokenPrice - fillPrice` — positive means the contract price rose after the buy (favorable)
- **Sell**: `fillPrice - futureTokenPrice` — positive means the contract price fell after the sell (favorable)

Reference price is derived from `market_book_snapshot` / `market_book_delta` midpoints
for the same `tokenId`. BTC spot or external ticks are **not used** for markout
reference unless explicitly labeled as such in a future separate field.

Horizons: 1s, 5s, 30s, settlement.

A markout is `null` with a reason when:
- No fill was recorded (`missing_fill`)
- No reference price observation exists near the target horizon (`missing_horizon`)
- A reference observation exists but cannot produce a price for the side (`missing_reference`)

---

## What the Scorer Does NOT Do

- Does not simulate the CLOB matching engine.
- Does not observe our actual queue position (the public feed does not expose this).
- Does not attribute public trades to specific wallets.
- Does not provide guaranteed fill classification — only evidence-based scoring.
- Does not change Strategy Lab ranking weights.
- Does not claim profitability.

---

## Data Requirements for Reliable Scoring

For `trade_through_fill` evidence:
- `market_trade` events with correct `tokenId`, `price`, and `shares` fields.

For `probable_fill` evidence (exact-price):
- `market_trade` events at the order price, **plus** known `queuePosition`.

For markouts:
- `market_book_snapshot` or `market_book_delta` events for the same `tokenId`,
  occurring after the fill at the correct horizon distances (1s, 5s, 30s).
- The raw L2 recorder (`engine/recorders/raw-l2-recorder.ts`) generates both of
  these event types into the NDJSON event store.

**Sparse replay fixtures (Phase 5B) will produce many `unknown_insufficient_data`
and `missing_horizon` outcomes.** The raw L2 recorder exists to fix this for new data.

## Paired Replay Token Mapping

Phase 8I repaired paired Strategy Lab replay so raw L2 evidence and replay fills can share real CLOB token IDs.

When a paired raw L2 file is supplied, Strategy Lab extracts ordered token IDs from:

- `payload.clobTokenIds` recorder metadata, or
- exactly one side-labeled `UP` token and exactly one side-labeled `DOWN` token.

Those IDs are passed into replay venue metadata, so generated `ORDER_INTENT` and fill telemetry use the same token IDs as raw L2 events. If mapping is missing or ambiguous, Strategy Lab does not guess. It records `token_mapping_missing` or `token_mapping_ambiguous` for eligible-fill runs.

This mapping fix does not loosen conservative scoring. `market_trade` is still required for `trade_through_fill`; book-only evidence remains `touch_only`.

## Trade-Print Source Rules

Phase 8J identified complete Polymarket market WebSocket `last_trade_price` messages as the public trade-print source. The recorder converts them into `market_trade` only when they contain:

- real CLOB token ID,
- finite price,
- finite size,
- finite source timestamp.

Incomplete last-trade data and CLOB last-trade-price snapshots remain weak reference data. They must not be counted as `trade_through_fill` because they do not prove size and time at the simulated order's placement horizon. Book touches remain `touch_only`.

---

## How This Prevents Fake Maker PnL

In optimistic replay, every simulated maker order at the best bid/ask is assumed to
fill whenever the opposite side touches it. This is unrealistic because:

1. Other makers ahead in queue fill first.
2. A touch that reverses immediately produces an adverse-selection loss, not a gain.
3. Touch-only fills without trade-through evidence are common in low-liquidity books.

The conservative scorer blocks optimistic fills by:
- Requiring trade-through evidence (or satisfied queue) before recording a fill.
- Returning `touch_only` for ambiguous touches — these do not count as fills.
- Applying negative markouts as adverse selection flags.

When `ConservativeFillScorer` is eventually integrated into Strategy Lab as the
primary fill oracle, any strategy that looks profitable only on optimistic fills will
show degraded or negative expected value under conservative scoring.

---

## What Remains Before Strategy Lab PnL Can Be Trusted

1. **Strategy Lab integration**: Wire `ConservativeFillScorer` into `engine/strategy-lab.ts`
   as the fill oracle for replay runs. This is the next phase. Integration must be
   report-only first (do not change ranking weights until scoring is validated on a
   larger corpus).

2. **Larger corpus**: The three Phase 5B fixtures cover only a short window and cannot
   produce statistically meaningful markout distributions. The raw L2 recorder should
   run continuously to accumulate 1,000+ rounds before tuning.

3. **Fee/rebate accounting**: Maker rebates must be estimated (not guaranteed) and
   subtracted from gross PnL before ranking.

4. **Adverse selection filter**: A strategy that consistently shows negative 1s
   markouts after fills should be penalized or blocked, not rewarded.

5. **Live fill comparison**: After tiny-live evidence exists, live fill rates should
   be compared to conservative scorer rates. Persistent disagreement would indicate a
   model failure.

---

## Files

| File | Purpose |
|---|---|
| `engine/replay/fill-scoring.ts` | `ConservativeFillScorer` class and types |
| `engine/replay/fill-model.ts` | Lower-level `ConservativeMakerFillModel` (book-snapshot-based, used standalone) |
| `engine/replay/markout.ts` | Post-fill markout calculation utilities |
| `engine/event-store/events.ts` | Typed event schema including `market_trade`, `market_book_snapshot`, etc. |
| `engine/recorders/raw-l2-recorder.ts` | Produces the raw L2 events that feed the scorer |
| `test/engine/fill-scoring.test.ts` | Full test suite for `ConservativeFillScorer` |
