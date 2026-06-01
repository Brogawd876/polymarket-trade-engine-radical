# Project State & Handoff

## Current Status

- Active repo: `polymarket-trade-engine-radical`
- Branch: `master`
- Mode: radical research fork; larger architecture and strategy risks are allowed here.
- Live-order invariant: the Type 3 deposit-wallet order path is proven and must be preserved.
- Runtime direction: the radical 10ms replay heartbeat is active and legacy tests should adapt to it.

## Repository Truth

The top-level `HANDOFF.md` is authoritative for the proven Type 3 wallet/order path and current champion notes. This file is the operational handoff for multi-agent continuity.

Current implementation includes:

- Type 3 CLOB order hardening with deposit-wallet maker/signer semantics.
- Conservative fill scoring and paired replay/L2 validation infrastructure.
- `fair-value-maker`, `avellaneda-maker`, and `radical-hybrid` strategies.
- Momentum-confirmed sizing variants through `fvm-v3.1.0-avellaneda-momentum`.
- Later experimental variants through v5.0.0, including fee-aware Avellaneda calibration.
- Efficient calibration-to-strategy pipeline scaffolding:
  - lean streaming calibration runner is the default corpus pipeline path;
  - Strategy Lab exposes lightweight progress polling;
  - raw L2 fill scoring uses cached token/time indexing;
  - paper-candidate calibration artifacts can be generated and loaded fail-closed;
  - `fvm-v5.1.0-avellaneda-isotonic` is the explicit calibrated variant.
- 10ms `ReplayRunner` heartbeat for radical replay/latency work.

## Current Health

- `npm run check` passes.
- Root `bun test` passes and now runs backend/root tests only.
- UI tests pass from `ui/` after installing UI dependencies.
- Stale `fair-value-maker` strategy tests were updated to explicitly bypass the max-spend cap where they are testing inventory skew rather than spend limits.
- Replay-runner tick logging is now opt-in via `ReplayRunnerOptions.verbose`.
- Efficient calibration pipeline implementation verified:
  - `npm run check`
  - `bun test` (`500 pass`, `7 skip`)
  - `cd ui; bun test` (`20 pass`)
- Calibration runtime bottleneck fixes verified:
  - Strategy Lab calibration runs can now mute replay/strategy console and file-buffer logging by default.
  - Lean calibration progress records failed slugs/errors and skips known failed slugs on resume unless `--retry-failed` is provided.
  - Lean/corpus calibration support explicit `--allow-partial` so completed evidence can still flow into audit/readiness while failed replay slugs remain reported.
- Replay-stall follow-up verified:
  - Strategy Lab now rejects replay logs that end before the slug's market-open timestamp without a market-price anchor or terminal resolution.
  - Lean calibration preflights replay fixtures and records unresolved/non-replayable slugs as explicit failed-slug reasons instead of letting them run until `Replay stalled`.
  - Replay adapter/orderbook debug output is opt-in via `REPLAY_DEBUG=true`; the 10ms heartbeat remains unchanged.
- Promising-strategy corpus run completed at `data/calibration-output/promising-2026-05-31`:
  - `fvm-v3.1.0-avellaneda-momentum`: 221 records, PnL `-791.7741`, adverse selection `94.4%`.
  - `fvm-v1.5.0-avellaneda`: 244 records, PnL `-874.8889`, adverse selection `98.9%`.
  - `fvm-v3.5.1-avellaneda-strict-gate`: 188 records, PnL `-585.9719`, adverse selection `92.2%`.
  - `fvm-v5.0.0-avellaneda-calibrated`: 241 records, PnL `-712.1283`, adverse selection `98.9%`.
  - Combined readiness was `blocked`: 894 total records / 5000 required and 870 trade-print-backed / 2000 required.

## Active Architectural Decisions

- Preserve the proven Type 3 account model:
  - `POLY_SIGNATURE_TYPE=3`
  - `POLY_FUNDER_ADDRESS` must be the owner-derived deposit wallet for the active owner.
  - Raw Type 3 orders must use maker/signer equal to the deposit wallet and order version `2`.
- Keep the radical 10ms heartbeat and update tests around it rather than slowing the engine for legacy timing assumptions.
- Do not relax risk gates based on counterfactual audit results without stronger evidence.
- Treat UI tests as a separate workspace concern; backend root tests should not require UI dependencies.
- Calibration artifacts must be generated only from `paper_candidate` readiness and consumed only by explicit calibrated variants.
- Calibrated variants fail closed if artifact path/schema/variant/evidence filter/split mode is invalid.

## Next Steps

1. Re-run lean calibration with `--retry-failed --allow-partial` if you want the existing failed-slug progress files to be reclassified with explicit unresolved replay reasons.
2. Acquire or capture more valid paired raw L2 data; current combined evidence is too small for calibration promotion.
3. Treat `fvm-v3.5.1-avellaneda-strict-gate` as the least-bad research candidate from this run, not a paper candidate.
4. If readiness later produces a paper-candidate artifact, run:
   `npm run calibrate:verify -- --variant fvm-v5.0.0-avellaneda-calibrated --out-dir data/calibration-verification`
5. Before live or paper promotion, rerun the Type 3 guardrail checks listed in top-level `HANDOFF.md`.
6. Keep `npm run check`, root `bun test`, and `cd ui; bun test` green before additional strategy changes.
