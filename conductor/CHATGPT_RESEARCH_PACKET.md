# Polymarket Radical Trade Engine: Consolidation & Refactor Prompt

You are an expert quantitative developer and systems architect. I am handing over a Polymarket BTC 5-minute trading engine that has seen rapid, innovative development but currently suffers from architectural fragmentation, dead code, and overlapping logic across multiple strategy variants. 

Your goal is to provide a master consolidation plan and the exact refactored code to unify the strategy execution plane, ensuring it is highly performant, mathematically sound, and "honest" in its backtesting.

## 1. The Project Goal
We are building a live-executable, low-latency bot for Polymarket 5-minute BTC UP/DOWN markets. The bot must generate consistent gains by using:
- Fee-aware fair value pricing (Black-Scholes digital option model).
- Isotonic calibration (de-biasing raw probabilities based on historical fill truth).
- Dynamic, momentum-confirmed position sizing.
- Strict execution logic (maker-first entry, FOK/FAK urgent exits).

## 2. The Current Fragmentation (The Problem)
The workspace has become fragmented due to experimental snapshots. 
- **The Logic Sink:** There is a directory `engine/strategy/consolidated_variants/` containing duplicated versions of our strategies (`master`, `live`, `original`, etc.). This has caused new features to be applied inconsistently. We need to delete this folder entirely and rely on a single source of truth in `engine/strategy/`.
- **Strategy Overlap:** `avellaneda-maker.ts` and `fair-value-maker.ts` are 95% redundant. `fair-value-maker.ts` is the advanced superset. We need to merge them.
- **Dead Code:** `radical-hybrid.ts` contains brilliant 10ms high-frequency taker logic but is poorly integrated. 

## 3. The Timing Mismatch (The Heartbeat)
The core engine (`ReplayRunner`) was successfully upgraded to a **10ms heartbeat**. However, older strategies like `late-entry.ts` still use `setInterval(..., 1000)` or `setInterval(..., 0)` busy-polls. 
- **The Goal:** All strategies must be refactored to be purely event-driven (subscribing to `ctx.ticker`) or use the engine's synchronized `ctx.clock.setInterval(..., 10)` to process ticks at the exact same speed as the market, eliminating CPU thrashing.

## 4. The "Honest" Execution Mandates
Recent audits enforced strict realism to prevent backtest hallucinations. The refactored code MUST preserve these invariants:
1. **Fee-Aware Edge:** Quote expected value (`quoteEv`) must subtract the `feeReference` before gating an entry.
2. **Urgent Exits:** Take-profit, Stop-loss, and Trailing-stop exits MUST use `FOK` (Fill-or-Kill) taker orders hitting the current bid/ask, not resting `GTC` maker orders.
3. **Calibrated Sizing:** The `fair-value-maker` MUST retain the wiring to pass its raw probability through the `predictIsotonicProbability` model if a `calibrationModel` is provided in the config.
4. **Spend Caps:** `maxSpendAbs` must accurately sum both existing inventory cost basis AND pending buy notional before allowing new quotes.

## Your Task

Please analyze this context and provide:
1. **The Architecture Plan:** How you will unify the `fair-value-maker`, `late-entry`, and `radical-hybrid` strategies into a clean, modular structure.
2. **The Refactored Code:** Provide the optimized, 10ms-synchronized TypeScript code for the unified strategies. Extract any shared math (e.g., Black-Scholes pricing, custom RSI/ATR/RTV indicators) into an `engine/strategy/utils.ts` or `engine/strategy/indicators.ts` file to eliminate duplication.

Focus on mathematical correctness, typescript strictness, and live-market execution reality.