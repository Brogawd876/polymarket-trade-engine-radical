# Active Architectural Decisions

## Runtime Spine Canonicalization (Phase 4)
- **Modular Refactoring:** `engine/early-bird.ts` acts as a legacy orchestrator. We will canonicalize the runtime by extracting pieces of `early-bird.ts` into a dependency-injected model so that `session-manager.ts` and `market-lifecycle.ts` can consume them directly.
- **Fail-Closed Migrations:** `early-bird.ts` cannot be deleted until all 7 integration test suites and the simulation framework naturally switch to the new injected spine. We extract instead of deleting.
- **Champion Strategy:** `fair-value-maker.ts` is the active benchmark and must not be altered mechanically during this refactoring phase. 
- **Risk Gate Fail-Closed:** Production predictive disagreement overrides are strictly disabled. Bypass flags like `BLOCK_ON_PREDICTIVE_DISAGREEMENT=false` are only permitted in simulation/replay. We retain divergence telemetry for analysis without compromising live security.

## Active Account/Deployment Rules
- Preserve the proven Type 3 account model:
  - `POLY_SIGNATURE_TYPE=3`
  - `POLY_FUNDER_ADDRESS` must be the owner-derived deposit wallet for the active owner.
  - Raw Type 3 orders must use maker/signer equal to the deposit wallet and order version `2`.
- `POLYGON_RPC_URL` and `POLY_API_KEY_NONCE` are explicitly mandatory for production deployment.
- `CHAINLINK_BTC_5M_REFERENCE_VERIFIED` is required to run live 5m BTC strategies.

## Performance/Timing Rules
- Keep the radical 10ms heartbeat and update tests around it rather than slowing the engine for legacy timing assumptions.
- Do not relax risk gates based on counterfactual audit results without stronger evidence.
- Treat UI tests as a separate workspace concern; backend root tests should not require UI dependencies.

## Calibration and Evidence
- Calibration artifacts must be generated only from `paper_candidate` readiness and consumed only by explicit calibrated variants.
- Calibrated variants fail closed if artifact path/schema/variant/evidence filter/split mode is invalid.

## Superseded Decisions
For historic decisions made prior to the Phase 3/4 repairs, please see the [Pre-Repair Decisions Archive](archive/DECISIONS_PRE_REPAIR.md).