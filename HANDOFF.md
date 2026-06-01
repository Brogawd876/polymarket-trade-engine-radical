# Handoff: Type 3 Deposit Wallet Corrected

## Status

Branch: `master`

The live Type 3 order path is proven end to end and must be preserved.

- Owner signer: `0x3528764a45bB13eC6BD8Deb1a73b5034742E6329`
- Correct POLY_1271 deposit wallet / `POLY_FUNDER_ADDRESS`: `0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51`
- Disproven funders: `0xbcbae6BE8cE9AD38C4FFD71254202f2aA27a30CF`, `0x609df252DF1371DBABD7aA234e028ACe9EAd90A2`
- CLOB credentials are freshly derived from the owner signer. Static `POLY_API_*` values are not authoritative for this flow.
- Raw Type 3 orders must build with maker/signer equal to the deposit wallet, `signatureType=3`, and order version `2`.

## Proven Acceptance Evidence

- `npm run check` passed before the acceptance run.
- Balance diagnostics showed approximately `$5` pUSD / CLOB balance on the corrected deposit wallet.
- `check-clob.ts` authenticated and open orders were `0` before the test.
- `verify-raw-order.ts` showed maker/signer `0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51`, `signatureType=3`, order version `2`.
- Live BTC 5-minute acceptance submitted a tiny order, received order ID `0xcd265e048093af8a07f4a5aa323d80698d4a99a1f0dab747cde7575196690028`, canceled it successfully, and verified no stray open order remained.

## Configuration Rules

- Keep `POLY_SIGNATURE_TYPE=3`.
- Keep `POLY_FUNDER_ADDRESS=0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51` for the current owner only.
- For a different owner wallet, derive the deposit wallet using `@polymarket/builder-relayer-client` `deriveDepositWallet(...)`; do not copy the current funder blindly.
- `BUILDER_*` credentials are only for relayer operations such as wrap/unwrap/redeem, not CLOB auth selection.

## Recommended Checks

```powershell
npm run check
bun test test/engine/type3-account-model.test.ts test/utils/clob-response.test.ts
bun run scripts/credential-ambiguity-diagnostic.ts
bun run scripts/check-balance.ts
bun run scripts/check-clob.ts
bun run scripts/verify-raw-order.ts
```

## Recent Fixes (Test Suite & Simulation Timing)

- **Ignored phantom 	argetNotional error:** Confirmed that the ReferenceError: targetNotional is not defined from earlier crashes is no longer possible because 	argetNotional is properly block-scoped (let) in engine/strategy/fair-value-maker.ts.
- **Restored test suite:** Fixed 16 failing tests in market-lifecycle.test.ts by removing the forced hurdle = 0.01 from isSimFilled in engine/client.ts, which restored optimistic fill logic for the mock lifecycle test suite.
- **Fixed test timing:** Added SIM_BALANCE_DELAY_MS = "4000" to Test 13 in market-lifecycle.test.ts so its promise correctly stays pending despite global SIM_MATCH_DELAY_MS = "0" changes.
- **Radical heartbeat restored:** This radical fork now uses `TICK_INTERVAL_MS = 10` in the replay runner. Tests should support the 10ms heartbeat rather than forcing the engine back to 100ms.

## FVM Safeguard Audit & Bug Fixes

- **Config Inheritance Bug:** Fixed `engine/strategy/index.ts` where advanced bots (v1.3.0 through v2.1.1) accidentally inherited `skipHygiene: true` and `minCvd10s: -Infinity`. Restored true champion gates (`skipHygiene: false`, `minCvd10s: -100`) to prevent bots from blindly trading into toxic retail stampedes.
- **Max Spend Cap Logic:** Fixed `engine/strategy/fair-value-maker.ts` to properly account for `totalSpendUp` / `totalSpendDown` when calculating `maxSpendAbs`. Prevents bots from bypassing the $15 limit and bankrupting the account on sequential loops.
- **Trailing Stop Taker Forcing:** Fixed `fair-value-maker.ts` to force `isTaker = true` on emergency trailing stops, ensuring stop-losses actually cross the spread during a crash instead of remaining stranded as unfillable Maker limit orders.
- **Strategy Validation:** Ran a 140-pass batch simulation across 10 5-minute volatility logs. Validated that **FVM v1.5.0 (Avellaneda Market Maker)** is the vastly superior architecture, generating +$68.81 by continuously capturing the spread regardless of directional outcome.

## v3.0.0 Momentum-Confirmed Dynamic Sizing (2026-05-31)

### Origin
Analysis of v1.1.1 (Raw, Gated) and v1.2.0 (Hygienic, Ungated) revealed near-identical performance (+$40.70 vs +$40.55). Both bots were leaving money on the table: fixed 10% sizing on 42% edge opportunities, and massive idle gaps (up to 37.8 hours) between trades.

### Research: Static Sizing Improvements (Failed)
Created 6 variants to address three shortcomings:
- **Dynamic Sizing (20% bankroll):** Made LESS (+$27.26 vs +$40.55) because larger positions hit `maxInventory` and `cashBudget` ceilings faster, reducing re-entry frequency from 11 to 9 fills.
- **Loose Gates (CVD -500, sigma 2.0):** CATASTROPHIC. Lost -$51.22 by entering toxic markets that the original gates correctly blocked.
- **Turbo (both combined):** Matched the Sized variant exactly (+$27.26). Take-profit at $0.95 never fired because trades exited at $0.70.

**Conclusion:** Original thresholds (CVD -100, sigma 1.5, imbalance -0.5) are correctly calibrated, not over-conservative.

### Bugs Found During Testing
1. **Cascade Multiplier Zeroing:** `edgeWeightedSizing: true` + `regimeWeightedSizing: true` (inherited from DEFAULT_CONFIG) can cascade to shrink `pct_of_balance` computed shares to zero. Must explicitly set `false` when using `pct_of_balance` without wanting edge/regime scaling.
2. **Non-Deterministic File Selection:** `readdirSync` returns files in filesystem order. Fixed by adding `.sort()` in `test-all.ts` for reproducible results across runs.

### Research: Momentum-Confirmed Dynamic Sizing (Succeeded)
**Insight:** The engine already pipes Binance and Coinbase price feeds via `ctx.predictive.binance` and `ctx.predictive.coinbase`, but only uses the current snapshot for Black-Scholes. By computing a 5-second rolling velocity ($/sec) from the composite price, we created an independent confidence signal that scales bet size WITHOUT changing entry gates.

**Implementation (files modified):**
- `engine/strategy/fair-value-maker.ts`: Added `momentumSizingEnabled`, `momentumWindowMs`, `momentumNeutralThreshold`, `momentumMaxPct`, `momentumMinPct` config fields. Velocity buffer tracks rolling composite price. Scales `effectivePct` between `momentumMinPct` (5%) and `momentumMaxPct` (25%) based on whether Binance/Coinbase velocity confirms or contradicts the trade direction.
- `engine/strategy/avellaneda-maker.ts`: Identical momentum logic ported for the Avellaneda engine.
- `engine/strategy/index.ts`: Added variants `fvm-v3.0.0-momentum-hygienic`, `fvm-v3.0.0-momentum-gated`, `fvm-v3.1.0-avellaneda-momentum`.

### Simulation Results (10 files, continuous $50 bankroll)

| Variant | PnL | Worst Round | Best Round | Fills |
|---|---|---|---|---|
| **v3.1.0 (Avellaneda + Momentum)** | **+$77.47** | -$49.37 | +$59.47 | 47 |
| v1.5.0 (Avellaneda) | +$68.82 | -$50.13 | +$51.95 | 53 |
| v3.0.0 (Momentum + Hygienic) | +$40.98 | $0.00 | +$22.71 | 14 |
| v1.2.0 (Hygienic, Ungated) | +$40.55 | $0.00 | +$40.55 | 11 |

**Key findings:**
- v3.1.0 beat v1.5.0 by +$8.65 (12.6% improvement)
- Momentum confirming: amplified best win from +$51.95 to +$59.47 (+$7.52)
- Momentum contradicting: reduced worst loss from -$50.13 to -$49.37 (+$0.76)
- Fewer fills (47 vs 53) — momentum's contradict signal skipped 6 marginal losing trades
- v3.0.0 (FVM family) found +$18.26 in a market the baseline ignored entirely

### Current Champion
**FVM v3.1.0 (Avellaneda + Momentum)** — Total PnL: +$77.47 across 10 markets.

## Current Cleanup Notes (2026-05-31)

- `AI_WORKSPACE/HANDOFF.md`, `ACTIVE_TASK.md`, and `SESSION_LOG.md` have been reconciled with this top-level handoff and the current radical code state.
- Root backend tests are separated from UI tests; UI checks should run from `ui/` with UI dependencies installed.
- `npm run check`, root `bun test`, and `cd ui; bun test` pass as of this cleanup.

## Efficient Calibration Pipeline (2026-05-31)

- The corpus calibration pipeline now defaults to lean streaming extraction, one variant at a time, using append-only calibration JSONL and resumable progress.
- Strategy Lab now exposes lightweight `getBatchProgress()` polling so calibration runners do not repeatedly structured-clone full run/evidence payloads.
- Raw L2 fill scoring now uses cached token/time indexing per Strategy Lab manager, preserving conservative fill semantics while avoiding repeated parse/sort work.
- Calibration artifacts are generated only when readiness returns `paper_candidate`; calibrated variants load artifacts fail-closed.
- New explicit calibrated variant: `fvm-v5.1.0-avellaneda-isotonic`.
- New commands:

```powershell
npm run calibrate -- --out-dir data/calibration-output --variants fvm-v5.0.0-avellaneda-calibrated
npm run calibrate:verify -- --variant fvm-v5.0.0-avellaneda-calibrated --out-dir data/calibration-verification
```

## Promising Strategy Calibration Run (2026-05-31)

- Ran the lean calibration pipeline on 290 valid paired manifests for:
  - `fvm-v3.1.0-avellaneda-momentum`
  - `fvm-v1.5.0-avellaneda`
  - `fvm-v3.5.1-avellaneda-strict-gate`
  - `fvm-v5.0.0-avellaneda-calibrated`
- Output directory: `data/calibration-output/promising-2026-05-31`.
- Runtime bottleneck fixes added during the run:
  - quiet replay logging by default in lean calibration, avoiding console/file-buffer memory growth;
  - persistent failed-slug/error checkpointing so deterministic replay stalls are skipped on resume unless `--retry-failed` is used;
  - explicit `--allow-partial` support so completed evidence can still reach audit/readiness while failed runs remain visible.
- Combined audit processed 894 records across 8 segments.
- Readiness decision: `blocked`; no calibration artifact was generated.
- Missing thresholds:
  - Total records: 894 / 5000.
  - Trade-print-backed records: 870 / 2000.
- Strategy results:
  - `fvm-v3.5.1-avellaneda-strict-gate`: PnL `-585.9719`, 188 records, adverse selection `92.2%`.
  - `fvm-v5.0.0-avellaneda-calibrated`: PnL `-712.1283`, 241 records, adverse selection `98.9%`.
  - `fvm-v3.1.0-avellaneda-momentum`: PnL `-791.7741`, 221 records, adverse selection `94.4%`.
  - `fvm-v1.5.0-avellaneda`: PnL `-874.8889`, 244 records, adverse selection `98.9%`.
- Interpretation: strict-gate is the least-bad research candidate on this corpus, but none is profitable or promotable.

## Replay Stall Follow-Up (2026-05-31)

- Strategy Lab now rejects replay logs that end before the slug's market-open timestamp when they lack both a `market_price` anchor and a terminal `resolution`.
- Lean calibration preflights replay fixtures and records unresolved/non-replayable slugs as failed-slug reasons instead of running them until `Replay stalled`.
- Generated replay-only manifests now use typed status values and mark incomplete premarket logs invalid.
- Replay venue/orderbook debug logging is opt-in via `REPLAY_DEBUG=true`; the radical 10ms replay heartbeat remains active.
- Verified:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run check
bun test test\engine\strategy-lab.test.ts test\engine\replay.test.ts test\engine\market-lifecycle.test.ts
bun test
cd ui; bun test
```

## Next Immediate Steps

1. Optionally re-run lean calibration with `--retry-failed --allow-partial` to reclassify old failed-slug progress entries with explicit unresolved replay reasons.
2. Capture more temporally separated, trade-print-backed paired raw L2 data; current evidence is too small for promotion.
3. Use `fvm-v3.5.1-avellaneda-strict-gate` as the next research baseline, not as a paper/live candidate.
4. If a future paper-candidate artifact is produced, run the verification command and compare calibrated holdout performance against `fvm-v3.1.0-avellaneda-momentum`.
5. Do not promote any calibrated variant to paper/live unless holdout quality, conservative fill quality, adverse selection, drawdown, and trade count are acceptable.
6. Before any paper/live promotion, rerun the Type 3 guardrail checks in the Recommended Checks section.
