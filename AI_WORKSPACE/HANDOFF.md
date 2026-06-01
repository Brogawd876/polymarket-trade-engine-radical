# HANDOFF

## Current Context
We are executing a multi-phase structural repair of the Polymarket BTC 5-minute trade engine.
The codebase is currently fragmented between a legacy runner (`engine/early-bird.ts`) and a modular bot-core spine driven by `session-manager.ts`.

## Immediate Goal
Transition safely to the modular bot-core spine, retain `fair-value-maker.ts` as the sole live champion strategy, and fix configuration and runtime validation without deleting code prematurely. 

## Next Steps
1. Repair `.env.sample` and `setup_env.py` mismatch.
2. Fix `package.json` and `.github/workflows/test.yml` dependency and test matrix drift.
3. Harden the `engine/client.ts` to expect explicit config requirements.
4. Run testing pipeline locally: `bun run check && bun test && cd ui && bun run lint && bunx vitest run && bun run build && cd ..`
