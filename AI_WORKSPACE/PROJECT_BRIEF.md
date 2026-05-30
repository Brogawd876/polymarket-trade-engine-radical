# Project Brief

## Purpose

Create a local, agent-portable research workspace for building a modular, low-latency, bot-first Polymarket BTC 5-minute trading system with a local operator deck for monitoring, override, and review.

## Repositories Under Study

- `repos/polyterm`: Polymarket-focused terminal/CLI project.
- `repos/polyrec`: Polymarket-related recommendation or research project.
- `repos/polymarket-trade-engine`: Polymarket trading engine project.

## Broader Goal

Build a locally hosted, modular, fast, intelligent Polymarket BTC 5-minute live-trading bot with a human-operator deck around it. The bot is the core product. The deck/UI is the monitoring, control, manual override, and post-run analysis layer.

The system must eventually support Polymarket venue data ingestion, resolution-source BTC data ingestion, optional external predictive BTC exchange feeds, synchronized multi-source timing, simulation, historical replay, paper trading, production-gated live trading, structured research logging, risk controls, fee/slippage awareness, stale-data protection, and operator override behavior.

## Current Phase

Phase 1 architecture correction is underway in `repos/polymarket-trade-engine`. The first skeleton now defines explicit boundaries for resolution-source BTC data, Polymarket venue data, external predictive feeds, strategy intents, and risk/execution gating. This is not a live trading phase.

## Hard Boundaries

Do not place trades. Do not request wallet keys, private keys, API secrets, or production trading credentials. Do not enable production trading.
