# Phase 8U: Capture Quality Audit

## Purpose

Before running larger capture batches to fill the corpus, this document classifies every field in the
capture/replay/calibration pipeline by its readiness requirement. Null values are never replaced with
fake data; they are explicitly tracked via `missingReasons` in `dataQuality`.

---

## Field Classification Table

| Field | Classification | Notes |
|-------|---------------|-------|
| **Pair Manifest** | | |
| `pairValidity` | **A — Required before serious capture** | Must be "valid" to include pair in corpus |
| `coverageVerdict` | **A — Required before serious capture** | Must be "complete" for valid pair |
| `rawL2EventCount` | **A — Required before serious capture** | Must be > 0 for valid pair |
| `rawL2TradeEventCount` | **A — Required before serious capture** | > 0 required; 0 generates warning |
| `recorderStopReason` | **A — Required before serious capture** | "unknown" is a warning, "crashed" is an error |
| `recorderCompletedEventSeen` | **A — Required before serious capture** | Must be true for SIGINT clean shutdown |
| `validationErrors` | **A — Required before serious capture** | Must be empty for valid pair |
| `parseErrors` | **A — Required before serious capture** | Must be empty for valid pair |
| `slug` | **A — Required before serious capture** | Must match both replay log and raw L2 log |
| `slotStartMs` / `slotEndMs` | **A — Required before serious capture** | Must be non-zero for temporal spread tracking |
| `gitCommit` | **B — Allowed null during capture** | Should be set; "unknown" is acceptable |
| `strategyLabEvidenceVerdict` | **B — Allowed null during capture** | "unavailable_no_fills" or "usable" both acceptable |
| `validationWarnings` | **B — Allowed null during capture** | Warnings are informational, not blockers |
| **Decision Feature Snapshot** | | |
| `settlementTruth.settlementAnchorPrice` | **A — Required before serious capture** | Null → `missing_chainlink_anchor` in missingReasons |
| `settlementTruth.roundId` | **A — Required before serious capture** | Null → `missing_chainlink_round_id` in missingReasons |
| `settlementTruth.rawOracleAnswer` | **A — Required before serious capture** | Required for settlement truth integrity |
| `settlementTruth.oracleLagMs` | **A — Required before serious capture** | Must be logged to detect staleness |
| `settlementTruth.sourceType` | **A — Required before serious capture** | Must be "chainlink_polygon" for authoritative capture |
| `settlementTruth.contractAddress` | **A — Required before serious capture** | Must match canonical Polygon BTC/USD address |
| `round.priceToBeat` | **A — Required before serious capture** | Must equal opening anchor price |
| `round.currentPrice` | **A — Required before serious capture** | Live Chainlink price at decision time |
| `round.gap` | **A — Required before serious capture** | Derived from currentPrice - openPrice |
| `orderbook.bid` / `orderbook.ask` | **A — Required before serious capture** | Null if venue feed was absent at decision time |
| `orderbook.spread` | **A — Required before serious capture** | Derived; null if bid/ask null |
| `orderbook.targetLiquidity` | **A — Required before serious capture** | Top-of-book depth at decision time |
| `feeds.resolutionFreshnessMs` | **A — Required before serious capture** | Staleness audit for settlement feed |
| `feeds.venueFreshnessMs` | **A — Required before serious capture** | Staleness audit for venue feed |
| `feeds.predictiveFreshnessMs` | **A — Required before serious capture** | Staleness audit for predictive feeds |
| `feeds.predictiveDisagreement` | **A — Required before serious capture** | Disagreement flag at decision time |
| `feeds.divergencePct` | **A — Required before serious capture** | Predictive vs settlement divergence |
| `risk.approved` | **A — Required before serious capture** | Whether risk gate approved the action |
| `risk.reasons` | **A — Required before serious capture** | Risk gate rejection reasons |
| `intent.action` | **A — Required before serious capture** | "buy" or "sell" |
| `intent.side` | **A — Required before serious capture** | "UP" or "DOWN" |
| `intent.price` | **A — Required before serious capture** | Quoted price at intent creation |
| `intent.shares` | **A — Required before serious capture** | Order size |
| `orderbook.slippageEstimatePct` | **B — Allowed null during capture** | Currently hardcoded null; improve before execution tuning |
| `feeds.leadLagConfidence` | **B — Allowed null during capture** | Null if lead-lag monitor hasn't stabilized |
| **Calibration Record** | | |
| `modelProbability` | **A — Required before serious capture** | Null → `missing_model_probability` in missingReasons |
| `fairValueEdge` | **A — Required before serious capture** | Null → `missing_fair_value_edge` in missingReasons |
| `bestBid` / `bestAsk` | **A — Required before serious capture** | Null if venue snapshot was absent |
| `spread` | **A — Required before serious capture** | Derived; null if bid/ask null |
| `topOfBookLiquidity` | **A — Required before serious capture** | Required for queue/fill analysis |
| `markout1s` | **A — Required before serious capture** | Null → `missing_markout_1s` in missingReasons |
| `markout5s` | **A — Required before serious capture** | Null → `missing_markout_5s` in missingReasons |
| `markout30s` | **A — Required before serious capture** | Null → `missing_markout_30s` in missingReasons |
| `dataQuality.hasMarketTradeEvidence` | **A — Required before serious capture** | False → touch-only (warning, not failure) |
| `dataQuality.missingReasons` | **A — Required before serious capture** | Explicit null-tracking, never silently empty |
| `calibratedProbability` | **B — Allowed null during capture** | Always null until isotonic calibration model built |
| `settlementMarkout` | **B — Allowed null during capture** | Requires settlement resolution (post-round data) |
| `predictiveDivergence` | **B — Allowed null during capture** | Null if predictive feed divergence unavailable |
| `volatilityEstimate` | **B — Allowed null during capture** | Null if sigma not primed at decision time |
| **Calibration Model / Paper/Live** | | |
| `pnlContribution` | **D — Required before live trading** | Per-fill PnL not yet computed |
| `slippageEstimatePct` | **C — Required before paper trading** | Full slippage model needed before execution tuning |
| Fill probability model | **C — Required before paper trading** | Requires captured corpus to build |
| Queue position model | **C — Required before paper trading** | Requires captured corpus to build |
| Fee-adjusted net edge | **C — Required before paper trading** | Requires fill model + fee data |
| Final calibrated probability | **C — Required before paper trading** | Requires labeled corpus of sufficient size |

---

## Chainlink Settlement Truth Audit

### What is verified (Phase 8U)

| Rule | Status |
|------|--------|
| Opening price / priceToBeat comes from Chainlink, not Binance/Coinbase | ✅ Verified |
| Close/current resolution price comes from Chainlink | ✅ Verified |
| Adapter records: roundId, rawOracleAnswer, decimals, chainUpdatedAtMs, localReceivedAtMs, oracleLagMs | ✅ Verified |
| Adapter records: freshnessMs, stalenessStatus, contractAddress, sourceType | ✅ Verified |
| Missing/stale/degraded state blocks or marks round as unusable | ✅ Verified (priceToBeat returns null) |
| Opening anchor NOT silently guessed | ✅ Verified (findOpeningAnchor returns null if no qualifying event) |
| Opening anchor NOT taken from predictive feed | ✅ Verified (sourceType = chainlink_polygon only) |
| Opening anchor selection uses Chainlink observation at or before round start | ✅ Verified (updatedAt <= startTimeMs filter) |
| If no authoritative anchor exists, validation marks pair unusable | ✅ Verified (priceToBeat returns null → decision blocked) |
| missingReasons tracks missing_chainlink_anchor | ✅ Added in Phase 8U |
| missingReasons tracks missing_chainlink_round_id | ✅ Added in Phase 8U |

---

## Raw L2 / Order-Book Capture Audit

### What is verified (Phase 8U)

| Rule | Status |
|------|--------|
| Every capture attempt writes a raw L2 file | ✅ Verified (captured or error) |
| Pair manifests include all required fields | ✅ Verified |
| Valid pairs require complete coverage | ✅ Verified |
| Valid pairs require meaningful raw L2 data (> 0 events) | ✅ Verified |
| Zero trade events → explicit warning (not silent) | ✅ Added in Phase 8U |
| Validator explains invalidity with clear reasons | ✅ Verified |
| Unknown recorder stop reason → explicit warning | ✅ Added in Phase 8U |
| Recorder SIGINT without completed event → validation error | ✅ Verified |
| Slug mismatch → validation error | ✅ Verified |
| Missing files → validation errors | ✅ Verified |
| Parse errors → invalid pair | ✅ Verified |

---

## Decision-Time Feature Logging Audit

### What is verified (Phase 8U)

| Question | Field | Status |
|----------|-------|--------|
| What round was this? | `round.window`, `round.startTimeMs`, `round.endTimeMs` | ✅ |
| What side was considered? | `orderbook.side` | ✅ |
| Was this buy or sell? | `intent.action` | ✅ |
| What price did the bot want? | `intent.price` | ✅ |
| What size did it want? | `intent.shares` | ✅ |
| How much time remained? | `round.timeRemainingMs` | ✅ |
| What was Chainlink priceToBeat? | `round.priceToBeat` | ✅ |
| What was current Chainlink price? | `round.currentPrice` | ✅ |
| What was distance from open anchor? | `round.gap` | ✅ |
| What was Polymarket best bid/ask? | `orderbook.bid`, `orderbook.ask` | ✅ |
| What was spread? | `orderbook.spread` | ✅ |
| What was top-of-book liquidity? | `orderbook.targetLiquidity` | ✅ |
| What were predictive feed values? | `predictiveTape.inputs` | ✅ |
| Did predictive feeds disagree? | `feeds.predictiveDisagreement` | ✅ |
| What was predictive divergence? | `feeds.divergencePct` | ✅ |
| How fresh were Chainlink/venue/predictive feeds? | `feeds.resolutionFreshnessMs`, `venueFreshnessMs`, `predictiveFreshnessMs` | ✅ |
| What risk gate reasons approved/blocked? | `risk.approved`, `risk.reasons` | ✅ |
| What strategy/config generated the decision? | `strategy.id`, `strategy.configHash` | ✅ |
| Was evidence trade-backed, touch-only, or missing? | `dataQuality.hasMarketTradeEvidence` | ✅ |
| What markouts exist at 1s, 5s, 30s? | `markout1s`, `markout5s`, `markout30s` | ✅ |
| Was Chainlink anchor present? | `settlementTruth.settlementAnchorPrice` + `missing_chainlink_anchor` | ✅ Added Phase 8U |

---

## Phase 8U Capture Quality Verdict

> **DO NOT claim profitability. DO NOT claim model readiness. DO NOT claim live readiness.**

The Phase 8U audit gate is designed to answer one question:
**Is the app collecting trustworthy enough data for replay/calibration?**

- ✅ Chainlink settlement truth: Authoritative and correctly tracked.
- ✅ Raw L2 capture: Required fields present; zero-trade-event warning added.
- ✅ Decision-feature logging: All required fields logged; Chainlink anchor now explicitly tracked in missingReasons.
- ✅ Pair validation: Fail-closed with clear error messages.
- ✅ Audit gate script: `scripts/audit-capture-quality.ts` now produces a machine-readable pass/warn/fail verdict.

### What remains blocked

- Pipeline readiness gate is still **BLOCKED** — insufficient corpus size (~6 valid pairs, need ~25).
- Calibrated probability model: **NOT BUILT** — `calibratedProbability` always null.
- Paper trading: **NOT ALLOWED** — fee-adjusted net edge, fill probability, queue position not modeled.
- Live trading: **NOT ALLOWED** — all of the above plus live risk gate review required.

### What is now allowed

- ✅ Controlled background capture using existing safe capture path.
- ✅ Incremental corpus building until readiness gate clears.
- ✅ Running `bun scripts/audit-capture-quality.ts` before each capture batch to verify quality.

---

_Phase 8U authored by automated agent. No live execution behavior changed._
_No profitability claim. No model-readiness claim. No live trading behavior changed._
