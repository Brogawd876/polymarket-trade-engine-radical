# Issue Log

Updated: 2026-08-02

## Open

### P1-001 — Promotion evidence is absent

- Gates 1-4 require sustained chronological/public-data cohorts that were not available during implementation.
- No profitability, calibration, drawdown, queue realism, or deployment claim may be made from unit/integration tests.
- Closure: immutable Gate 1-4 packages satisfying the exact promotion criteria and statistically justified cohort sizes.

### P1-002 — New production runtime is not yet the public-data operator process

- `ProductionTradingRuntime` provides an integrated replay/shadow/paper decision-to-ledger path but is intentionally restricted to `DeterministicFakeExchange`.
- The legacy UI/control plane reports truthful blocked health but does not expose every new ledger, model, market, EV, lot, and reconciliation field in one production proof view.
- Closure: assemble the zero-submission public-data shadow process, connect the production health/proof surface, and validate it during Gate 1/4 evidence runs.

### P1-003 — Transitive dependency advisories

- `npm audit --omit=dev --audit-level=critical` exits successfully with no critical findings.
- It reports 21 findings: 13 low, 5 moderate, and 3 high, including axios, elliptic, esbuild, and ws paths; several are inherited through current Polymarket/ethers packages and report no fix.
- Closure: upgrade when compatible upstream releases exist, remove unused dependency paths, or document tested containment before deployment.

### P2-004 — UI bundle size

- Production build succeeds but the main JavaScript chunk is approximately 515 kB minified.
- Closure: route-level/code splitting after safety evidence work.

### P2-005 — Formal Gate 0 package not recorded

- Gate 0 requirements have code and test evidence, but no immutable promotion package has been accepted into a durable promotion authority.
- Closure: review the fault-coverage matrix and verification output, then record the package without changing any criterion.

## Closed in the Non-Live Production Path

### P0-001 — Non-authoritative accounting

- Closed by exact fixed-point `LotLedger`, FIFO lots, reservations, fees, rebates, transfers, settlement, journal replay, and restart tests.
- Legacy `WalletTracker` remains simulation-only and has no live authority.

### P0-002 — Orphan and reconciliation blindness

- Closed by exchange-wide reconciliation snapshots, orphan/missing order detection, pending-trade detection, exact wallet/token comparison, and fail-closed startup/outage/shutdown assertions.

### P0-003 — Missing durable outbox

- Closed by journal-before-submit `ExecutionOutbox`, correlation IDs, ambiguity state, no-blind-retry rule, and crash/restart restoration.

### P0-004 — Incomplete order lifecycle

- Closed by the intent-to-settlement state machine, partial GTC remainder retention, cancel/fill races, duplicate trade/ack handling, and false-complete prevention.

### P0-005 — Inexact market and anchor state

- Closed by `MarketRegistry`, exact slug/window/outcome/rules identity, Chainlink-only anchor proof, exact Price-to-Beat comparison, source-time freshness, and dynamic market parameters.

### P0-006 — Incomplete CLOB execution semantics

- Closed for the non-live adapter/fake-exchange path by current CLOB V2 dependencies, GTC post-only semantics, FAK/FOK handling, dynamic parameters, delayed/partial evidence, and eventual-consistency recovery.
- Real transport remains intentionally unavailable pending prior gates and authorization.

### P0-007 — Replay fabricated settlement truth

- Replay no longer falls back to predictive/ticker values. A recording without explicit settlement evidence fails closed and cannot claim completion.

### P0-008 — Failed redemption credited cash

- Settlement accounting is deferred until redemption succeeds. Failure emits `INVALID_RUN`, preserves cash/inventory, and keeps the lifecycle in `STOPPING`.

### P0-009 — Live submission reachable through legacy surfaces

- CLI, session, kernel, client, operator promotion routes, historical acceptance scripts, and cancellation scripts all fail closed.

### P0-010 — Evidence loss or overwrite

- Unique run directories, exclusive raw stream creation, fsync, hashes, completeness verdicts, recorder fatal state, disk-full injection, and replay-source immutability tests are in place.

### P0-011 — Mutable legacy benchmark

- FVM v1.1.0 Raw/Ungated now has an immutable config, distinct replay-only entry point, and SHA-256 regression pins for both entry point and delegated implementation.

### P0-012 — Unsafe or opaque production defaults

- Secret scan, forbidden-default scan, mandatory production operator auth, localhost bind, structured dependency health, live-disabled defaults, and CI enforcement are in place.
