# HANDOFF

## Current Context
We are executing a multi-phase structural repair of the Polymarket BTC 5-minute trade engine.
The codebase is currently fragmented between a legacy runner (`engine/early-bird.ts`) and a modular bot-core spine driven by `session-manager.ts`.

## Immediate Goal
Transition safely to the modular bot-core spine, retain `fair-value-maker.ts` as the sole live champion strategy, and fix configuration and runtime validation without deleting code prematurely. 

## Next Steps
1. Execute **Extraction 3**: Update `SessionManager` to assemble the dependencies using `InfrastructureFactory` and pass them directly to `MarketSpawner`, bypassing `EarlyBird` for live/sim paths.
2. Execute **Extraction 4**: Refactor the 7 test suites to use the new `MarketSpawner` instead of `EarlyBird`.
3. Stop and request review before archiving `early-bird.ts`.
4. Run testing pipeline locally: `bun run verify`
