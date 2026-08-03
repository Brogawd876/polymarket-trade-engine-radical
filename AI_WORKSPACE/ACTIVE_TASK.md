# Active Task: Gate 1 Evidence Collection

Status: **READY TO START; NO LIVE AUTHORITY**

## Objective

Run the immutable recorder and production shadow path continuously without orders, then decide Gate 1 strictly from measured evidence.

## Completed Implementation

1. Recovered and audited the intended repository line and the full 1,876-line master prompt.
2. Implemented Phases A-H as a fail-closed non-live production architecture.
3. Added the exact journal/outbox/lifecycle/ledger/reconciliation authority and crash recovery.
4. Added exact market, anchor, feed, venue-book, dynamic market-info, and model-artifact authority.
5. Added current CLOB V2 semantics behind an adapter, deterministic fake exchange, immutable recorder, continuous replay state, model pipeline/parity, strategy/exits, risk engine, health contract, promotion manager, CI, and security checks.
6. Added deterministic fault coverage for ambiguity, partial fills, cancellation races, restarts, stale clocks, book gaps, post-only/FOK/FAK behavior, disk failure, settlement equality, missing settlement evidence, failed redemption, kill switch, loss limits, and false-complete shutdown.
7. Verified the complete test and release-check matrix.

## Next Evidence Work

1. Assemble the public-data recorder/shadow process with no exchange-submission dependency.
2. Capture unique immutable runs and manifests over a representative chronological cohort.
3. Measure completeness, source latency, clock offsets, reconnects, dropped messages, and feature reproducibility.
4. Produce and validate a Gate 1 evidence package.
5. Only after Gate 1 passes, run the chronological offline model and realistic continuous-replay evidence programs for Gates 2 and 3.
6. Gate 4 requires a live-data paper cohort with simulated orders and measured latency.

## Hard Boundary

Do not place, cancel, or redeem real positions. Gate 5 requires a new explicit authorization containing bankroll, maximum loss, venue-minimum order size, cohort, strategy/model/config hashes, kill-switch behavior, and every prior evidence package. Gate 6 requires another separate authorization.
