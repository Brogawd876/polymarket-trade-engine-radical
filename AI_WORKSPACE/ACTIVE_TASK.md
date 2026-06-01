# ACTIVE_TASK

## Current Task
Execute the repair of the `polymarket-trade-engine-radical` branch according to the revised implementation plan.

## Phase 3 Completion
- [x] Unify `.env.sample` and `setup_env.py` (added missing values).
- [x] Hardened `engine/client.ts` to strictly block missing `POLYGON_RPC_URL` and `CHAINLINK_BTC_5M_REFERENCE_VERIFIED` in production.
- [x] Repaired exact string test expectations to account for divergence telemetry in risk-gate block reasons.
- [x] Verified fail-closed risk gate behavior regardless of `BLOCK_ON_PREDICTIVE_DISAGREEMENT` flag in production environments.
- [x] Pinned `bun-version: 1.3.14` in `.github/workflows/test.yml` safely.

## Immediate Next Steps (Phase 4: Canonicalize Runtime Spine)
1. **Extraction 1 (Smallest Safe Extraction):** Extract adapter initialization logic (Binance, Coinbase, Chainlink, Aggregator) out of `EarlyBird`'s constructor and into an injectable `BotContextFactory` or similar mechanism inside `bot-core/`. Ensure `EarlyBird` uses this behind the scenes so the 7 test suites importing it remain green.
2. Run `bun test` and `bun run check`.
3. Stop and report findings.

## Success Criteria
- `early-bird.ts` slims down without breaking any existing dependent tests.
- FVM remains the intact champion strategy.
- No massive file deletions occur until tests natively use the new runtime spine.
