# ChatGPT Research Packet: Polymarket Live-Test Shutdown

## Purpose

Use this packet to brief ChatGPT or another research agent on the current Polymarket BTC 5-minute trading bot state, especially the live-test shutdown and unresolved API signer mismatch.

## Workspace

- Root: `C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab`
- Main engine repo: `C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polymarket-trade-engine`
- Separate live clone exists: `C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polymarket-trade-engine-live`
- Shared docs: `C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\AI_WORKSPACE`

## What Happened

On 2026-05-19, the live trading engine was found running:

```powershell
bun run index.ts --strategy fair-value-maker --prod --always-log
```

It was serving the operator API on port `3000` and the UI dev server was running on port `5173`.

The user requested shutdown. The engine was stopped through:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3000/api/operator/session/stop
```

The stop request returned:

```json
{ "success": true }
```

After a short wait:

- `bun` trading engine process was gone.
- Port `3000` was closed.
- UI dev server remained running on `5173`.

## Final Engine State

File:

```text
C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polymarket-trade-engine\state\early-bird-prod.json
```

Final state summary:

- `sessionPnl`: `0`
- `sessionLoss`: `0`
- `activeMarkets`: `[]`
- Completed live markets:
  - `btc-updown-5m-1779201000`
  - `btc-updown-5m-1779201300`
  - `btc-updown-5m-1779201600`
  - `btc-updown-5m-1779201900`
  - `btc-updown-5m-1779202200`
- Every completed market had:
  - `pnl`: `0`
  - `orderHistory`: `[]`

Interpretation: no successful live fills were recorded in engine state.

## Key Log File

Fresh live-run log:

```text
C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polymarket-trade-engine\logs\early-bird-2026-05-19-14-28-12.log
```

Startup excerpt:

```text
[2026-05-19T14:28:12.745Z] [startup] Starting
[2026-05-19T14:28:15.563Z] [startup] Initializing client
[2026-05-19T14:28:15.564Z] [startup] Client initialized
[2026-05-19T14:28:16.607Z] [startup] On-chain balance: $8.00
[2026-05-19T14:28:16.607Z] [wallet] Init: $8.00
[2026-05-19T14:28:16.607Z] [startup] Min session PnL exit: $5.00
```

Primary failure:

```text
[placement] Order failed: the order signer address has to be the address of the API KEY
[btc-updown-5m-1779201000] Order placement failed (BUY UP @ ...): the order signer address has to be the address of the API KEY
```

Observed counts from the fresh live-run log:

```text
Order placement failed                                         2600
the order signer address has to be the address of the API KEY  5200
Risk gate blocked                                               310
No quote: Chainlink                                             139
filled                                                            0
Settled. PnL                                                      5
Session PnL                                                       6
Explicit stop requested                                           1
```

Shutdown excerpt:

```text
[2026-05-19T14:47:04.699Z] [shutdown] Explicit stop requested
[2026-05-19T14:47:04.699Z] [shutdown] Signalling all lifecycles to cancel.
[2026-05-19T14:47:04.700Z] [btc-updown-5m-1779201900] state: RUNNING -> STOPPING
[2026-05-19T14:47:04.700Z] [btc-updown-5m-1779202200] state: RUNNING -> STOPPING
[2026-05-19T14:47:04.725Z] [btc-updown-5m-1779201900] Settled. PnL: +$0.00
[2026-05-19T14:47:04.725Z] [btc-updown-5m-1779202200] Settled. PnL: +$0.00
[2026-05-19T14:47:04.727Z] [shutdown] All settled. Exiting.
[2026-05-19T14:47:05.208Z] [early-bird] Stopped all adapters
```

## Important Contradiction

The handoff docs claimed the Gnosis Safe / signature-type issue had been fixed and the engine was ready for a live test.

However, the actual live run still failed with:

```text
the order signer address has to be the address of the API KEY
```

So the current highest-priority research/debug target is still authentication/signing alignment between:

- API key owner address
- order signer address
- maker/funder address
- Gnosis Safe or smart contract wallet signature type
- Polymarket CLOB client behavior

## Files Likely Relevant To Research

Main code paths:

```text
repos\polymarket-trade-engine\engine\client.ts
repos\polymarket-trade-engine\engine\early-bird.ts
repos\polymarket-trade-engine\engine\market-lifecycle.ts
repos\polymarket-trade-engine\engine\bot-core\risk-gate.ts
repos\polymarket-trade-engine\engine\user-channel.ts
repos\polymarket-trade-engine\utils\fetch-retry.ts
```

Debug/helper scripts:

```text
repos\polymarket-trade-engine\scripts\audit-connectivity.ts
repos\polymarket-trade-engine\scripts\check-balance.ts
repos\polymarket-trade-engine\scripts\check-clob.ts
repos\polymarket-trade-engine\scripts\probe-wallets.ts
repos\polymarket-trade-engine\scripts\test-order.ts
```

Workspace docs:

```text
AI_WORKSPACE\ACTIVE_TASK.md
AI_WORKSPACE\HANDOFF.md
AI_WORKSPACE\DECISIONS.md
AI_WORKSPACE\SESSION_LOG.md
```

## Git/Dirty State Snapshot

Top workspace:

```text
AI_WORKSPACE\ACTIVE_TASK.md modified
AI_WORKSPACE\DECISIONS.md modified
AI_WORKSPACE\HANDOFF.md modified
AI_WORKSPACE\SESSION_LOG.md modified
AI_WORKSPACE\batch_request.json untracked
AI_WORKSPACE\batch_request_49.json untracked
research\ untracked
screenshot\ untracked
```

Main engine repo:

```text
branch: master...origin/master [ahead 4]
modified:
  engine/bot-core/data-sources.ts
  engine/bot-core/risk-gate.ts
  engine/client.ts
  engine/early-bird.ts
  engine/market-lifecycle.ts
  engine/user-channel.ts
  test/engine/early-bird.test.ts
  utils/fetch-retry.ts
untracked:
  .env.backup
  scripts/audit-connectivity.ts
  scripts/check-balance.ts
  scripts/check-clob.ts
  scripts/probe-wallets.ts
  scripts/test-order.ts
```

Separate live clone:

```text
branch: master
modified:
  .env.backup
untracked:
  scripts/query-all-balances.ts
  scripts/test-clob-balance.ts
```

## Research Questions For ChatGPT

1. In Polymarket CLOB v2, for browser-created accounts using a Gnosis Safe proxy wallet, which address must own the API key: the EOA, the Safe, or the funder?
2. Which `signatureType` should be used for this setup, and how does it affect the order `maker` and `signer` fields?
3. Does `@polymarket/clob-client` derive API keys from the signer address, and can the order builder signer differ from the HTTP auth signer?
4. Why would balance checks succeed while order placement fails with `the order signer address has to be the address of the API KEY`?
5. What is the minimal safe live-order probe to validate signer/API-key alignment without risking a fill?
6. How should the code fail closed if signer/API-key mismatch is detected before strategy loops begin?

## Safety Note

Do not run live trading again until the signer/API-key mismatch is understood and a preflight check prevents repeated live placement attempts. The last run recorded no fills, but it repeatedly attempted live order placement.
