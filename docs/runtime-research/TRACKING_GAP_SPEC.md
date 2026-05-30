# Tracking Gap Specification

## Storage

Use append-only NDJSON events under `logs/events/<runId>/events.ndjson`. The first implementation is intentionally local and cheap. SQLite/DuckDB indexing can be layered on later without changing event semantics.

## Envelope

Every event uses:

`eventId`, `schemaVersion`, `runId`, `sessionId`, `roundId`, `slug`, `eventType`, `source`, `sourceTsMs`, `receivedTsMs`, `processedTsMs`, `monotonicNs`, `commitSha`, `strategyId`, `configHash`, `payload`.

## Event Families

| Family | Event types | Profit use |
|---|---|---|
| Market data | `market_book_snapshot`, `market_book_delta`, `market_trade`, `market_status_change`, `spread_depth_snapshot` | raw L2 replay, queue modeling, spread/depth, adverse selection |
| Predictive feeds | `external_trade_tick`, `external_price_tick`, `external_l2_snapshot`, `external_l2_delta`, `feed_freshness_snapshot` | fair value, lead-lag, stale-feed gates |
| Settlement | `chainlink_update`, `resolution_anchor`, `price_to_beat`, `settlement_result` | settlement truth and replay labels |
| Strategy/risk | `strategy_decision`, `model_probability`, `calibrated_probability`, `market_implied_probability`, `edge_estimate`, `no_trade_reason`, `risk_gate_decision`, `regime_label`, `jump_flag` | calibration and no-trade analysis |
| Execution | `order_intent`, `order_submitted`, `order_acknowledged`, `order_canceled`, `cancel_acknowledged`, `order_filled`, `partial_fill`, `order_expired`, `maker_taker_classification`, `fee_rebate_estimate` | execution realism and net EV |
| Fill realism | `queue_estimate`, `size_ahead_estimate`, `trade_through_event`, `fill_probability_estimate`, `adverse_selection_flag` | conservative maker fill testing |
| Markouts | `markout_1s`, `markout_5s`, `markout_30s`, `settlement_markout` | adverse-selection and hold-quality proof |
| Operations | `run_started`, `run_completed`, `code_commit`, `config_hash`, `strategy_version`, `env_profile`, `dependency_versions`, `host_latency_profile`, `feed_health`, `operator_action` | provenance, auditability, safety |

## Current Tranche

Implemented schema coverage and writer support for all families. Runtime currently mirrors run lifecycle, resolution anchor/price-to-beat, strategy decisions, risk decisions, order lifecycle, spread/depth snapshots, and settlement result. Raw websocket delta capture and Strategy Lab markout integration remain next work.
