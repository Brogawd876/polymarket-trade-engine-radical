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
- [x] **Extraction 1:** Extracted `BotInfrastructure` and `InfrastructureFactory` into `bot-core/`.
- [x] **Extraction 2:** Extracted `MarketSpawner` into `bot-core/`. Fixed orchestration bugs in shutdown loop with rigorous tests.
3. **Extraction 3:** Update `SessionManager` to assemble the dependencies using `InfrastructureFactory` and pass them directly to `MarketSpawner`.
4. **Extraction 4:** Refactor the 7 test suites to use the new `MarketSpawner` instead of `EarlyBird`.
5. Run `bun run verify`.
6. Stop and report findings.

## Success Criteria
- `early-bird.ts` slims down without breaking any existing dependent tests.
- FVM remains the intact champion strategy.
- No massive file deletions occur until tests natively use the new runtime spine.
