# Phase UI-1: Operator Cockpit Stabilization

## Status: IN PROGRESS (branch: feat/phase-ui1-operator-cockpit)

## Goal

Stabilize the operator cockpit UI as a reliable engine-state monitoring surface. This phase does **not** change live execution, risk gates, order placement, strategy logic, readiness gates, or ranking weights.

---

## What Was Built

### Connection Configuration

| File | Change |
|---|---|
| `ui/src/api.ts` | NEW — shared API client with `VITE_API_BASE_URL`, `VITE_WS_URL`, `VITE_OPERATOR_AUTH_TOKEN` |
| `ui/.env.example` | NEW — documents all supported env vars |
| `ui/src/hooks/useTelemetry.ts` | MODIFIED — uses `apiFetch`/`WS_URL` from `api.ts` instead of hardcoded URLs; surfaces auth/network errors to store |
| `ui/src/components/LiveMonitor/SessionCommandBar.tsx` | MODIFIED — uses `apiFetch` instead of hardcoded API_BASE |
| `ui/src/store/index.ts` | MODIFIED — adds `connectionError`/`setConnectionError` and `corpusSummary`/`setCorpusSummary` |
| `ui/src/components/layout/AppLayout.tsx` | MODIFIED — adds amber connection error banner when `connectionError` is set |

### New Panels

| Panel | File | Purpose |
|---|---|---|
| **Why No Trade?** | `WhyNoTradePanel.tsx` | Risk gate decision + blockers, feed stale flags, spread/slippage/liquidity, signal quality, session block reason, last intent |
| **Corpus Summary** | `CorpusSummaryPanel.tsx` | Polls `/api/operator/corpus-summary` every 30s; shows graceful 404 fallback |

### LiveMonitor Layout

- `WhyNoTradePanel` replaces basic `RiskPanel` in the right-column grid (next to `PredictiveSignalPanel`)
- `CorpusSummaryPanel` added at the bottom
- `RiskPanel.tsx` kept (used by existing tests) but removed from LiveMonitor render

### Tests

| File | Covers |
|---|---|
| `ui/src/api.test.ts` | URL config (env vars → defaults), auth header injection, no-auth path, network failure, 401/403/500 |
| `LiveMonitor.test.tsx` | Route render smoke, corpus 404 fallback, WhyNoTradePanel present, empty state |
| `WhyNoTradePanel.test.tsx` | Empty state, blocked reasons, last intent, stale feeds, all-live, session block |

### CI

`.github/workflows/test.yml` updated to add:
- `bun run lint` (UI lint)
- `bunx vitest run` (UI Vitest)
- `bun run build` (UI production build)

---

## Decisions Made

- **`VITE_OPERATOR_AUTH_TOKEN`**: mirrors backend `OPERATOR_AUTH_TOKEN`. Token kept in module scope inside `api.ts`, never logged or exported.
- **`WhyNoTradePanel` replaces `RiskPanel`** in the cockpit grid: `RiskPanel.tsx` file is preserved for backward compat with existing tests.
- **Corpus panel gracefully handles 404**: no backend changes required in this phase.
- **No strategy/risk/readiness/order logic changed.**

---

## Acceptance Criteria

- [x] `bun run check` passes (backend typecheck)
- [x] `bun test --max-concurrency=1` passes (444 pass, 7 skip, 0 fail)
- [ ] `bun run lint` passes
- [ ] `bunx vitest run` passes
- [ ] `bun run build` passes
- [x] No live trading behavior changed
- [x] No strategy/risk/readiness changes
- [x] No secrets exposed in browser
- [x] UI can run against configurable backend URL
- [x] Blocked trade reasons are visible

---

## What Remains

- Wire `/api/operator/corpus-summary` endpoint on the backend (Phase 8T or later)
- Strategy Lab preset-level config display improvements
- Mobile/narrow viewport audit
