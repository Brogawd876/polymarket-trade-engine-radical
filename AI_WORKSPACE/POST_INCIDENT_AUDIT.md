# Post-Incident Audit: Type 3 Deposit Wallet Fix

Date: 2026-05-20

## Baseline

- Current branch: `master`
- Current fixed checkpoint: `e17796a fix(auth): lock type3 deposit wallet path`
- `PRE_INCIDENT_BASE`: `3643144 docs: add ChatGPT research packet for live test`
- `FIXED_HEAD`: `e17796a`

`3643144` is the most defensible pre-incident baseline because it immediately precedes the committed signer/API-key debugging sequence (`16a3a62`, `02fbc37`, `c7d02b9`, `5972ebb`, `198654a`) and the final Type 3 correction. Earlier commits are also pre-incident, but they include unrelated CI/UI/live-readiness work and are less precise for this blast-radius audit.

## Proven State To Preserve

- Owner signer: `0x3528764a45bB13eC6BD8Deb1a73b5034742E6329`
- Correct POLY_1271 deposit wallet: `0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51`
- Wrong funders not active: `0xbcbae6BE8cE9AD38C4FFD71254202f2aA27a30CF`, `0x609df252DF1371DBABD7aA234e028ACe9EAd90A2`
- CLOB credentials: freshly derived from owner signer, not static `POLY_API_*`
- Type 3 raw order: maker/signer = deposit wallet, `signatureType=3`, order version `2`
- Live acceptance: real BTC 5m order accepted, canceled, and open orders returned to zero.

## Blast Radius Inventory

`git diff --stat 3643144..e17796a` showed 47 files changed, 5643 insertions, 28 deletions.

| File | Change summary | Why it changed | Required for final fix? | Disposition | Risk | Evidence / notes |
|---|---|---|---|---|---|---|
| `.env.sample` | Added Type 3 funder/auth sample | Persist correct account model | YES | Keep, hardened | Low | Now states the funder is owner-specific and old funders must not be reused. |
| `.gitignore` | Ignores Type 3 debug archive | Quarantine scratch scripts | PARTIAL | Keep | Low | Prevents future scratch material from entering active tree accidentally. |
| `AI_WORKSPACE/ACTIVE_TASK.md` | Current Type 3 state | Handoff after incident | PARTIAL | Keep | Low | Correctly names owner/funder and stale funders as not live. |
| `AI_WORKSPACE/BTC_5M_LIVE_TRADER_ARCH_AUDIT.md` | Architecture audit notes | Pre-incident/handoff documentation | NO | Keep as historical | Low | Not active runtime. |
| `AI_WORKSPACE/COMMANDS.md` | Command inventory | Workspace continuity | NO | Keep | Low | Documentation only. |
| `AI_WORKSPACE/DECISIONS.md` | Historical decisions plus incident decisions | Continuity | PARTIAL | Document-only update | Medium | Added 2026-05-20 superseding Type 3 decision because 2026-05-19 Type 2 decision was false. |
| `AI_WORKSPACE/ENVIRONMENT.md` | Environment notes | Workspace continuity | NO | Keep | Low | Documentation only. |
| `AI_WORKSPACE/GIT_WORKFLOW.md` | Git workflow notes | Workspace continuity | NO | Keep | Low | Documentation only. |
| `AI_WORKSPACE/HANDOFF.md` | Type 3 handoff | Final incident state | YES | Keep | Low | Contains accepted order/cancel evidence. |
| `AI_WORKSPACE/PROJECT_BRIEF.md` | Project brief | Workspace continuity | NO | Keep | Low | Documentation only. |
| `AI_WORKSPACE/SESSION_LOG.md` | Full incident history | Forensics | PARTIAL | Keep historical | Medium | Contains disproven theories, but later entries correct them. |
| `AI_WORKSPACE/SETUP_AUDIT.md` | Setup audit notes | Workspace continuity | NO | Keep | Low | Documentation only. |
| `AI_WORKSPACE/TRADE_DECK_BLUEPRINT.md` | UI/deck plan | Prior workspace work | NO | Keep | Low | Not active runtime. |
| `AI_WORKSPACE/WORKSPACE_MAP.md` | Workspace map | Workspace continuity | NO | Keep | Low | Documentation only. |
| `AI_WORKSPACE/batch_request.json` | Research packet artifact | Incident/research support | NO | Keep historical | Low | Not runtime. |
| `AI_WORKSPACE/batch_request_49.json` | Research packet artifact | Incident/research support | NO | Keep historical | Low | Not runtime. |
| `engine/bot-core/data-sources.ts` | Timer typing tightened | Hardening during incident | NO | Keep | Low | Type-only safety improvement. |
| `engine/bot-core/risk-gate.ts` | Default risk/execution limits tightened | Safety hardening | NO | Keep, document | Medium | Behavior policy change; safer but may block more orders. Tests cover gate behavior. |
| `engine/client.ts` | Type 3 auth derives CLOB credentials from owner signer and uses funder for trading client | Final root-cause fix | YES | Keep | Low | Core accepted live path. |
| `engine/early-bird.ts` | Timer typing; incident also relaxed divergence threshold | Hardening plus temporary live-debug tweak | PARTIAL | Reverted threshold relaxation | Medium | Removed `divergenceThresholdAbs: 150`, restoring default $50 behavior. |
| `engine/market-lifecycle.ts` | Timer typing tightened | Hardening during incident | NO | Keep | Low | Type-only safety improvement. |
| `engine/user-channel.ts` | Logs parse failures | Observability hardening | NO | Keep | Low | Helps avoid silent websocket failures. |
| `engine/bot-core/predictive-signal-aggregator.ts` | Runtime-compatible optional `latestAnchor` use | Regression found during audit | NO | Hardened | Low | Prevents older/test resolution adapter shapes from throwing asynchronously. |
| `engine/bot-core/quant-monitor.ts` | Runtime-compatible optional `latestAnchor` use | Regression found during audit | NO | Hardened | Low | Same guard for quant monitor subscribers. |
| `package-lock.json` | npm lockfile added | Dependency reproducibility | PARTIAL | Keep | Medium | Pins builder/clob dependencies used by accepted path; repo also has Bun lock. |
| `package.json` | Added builder-relayer, clob-client-v2, dotenv | Final derivation and diagnostics | PARTIAL | Keep | Medium | Builder relayer is essential for official derivation; clob v2 is accepted live path. |
| `research/deep-research-report - v2.md` | Research artifact | Investigation context | NO | Keep historical | Low | Not runtime. |
| `research/deep-research-report.md` | Research artifact | Investigation context | NO | Keep historical | Low | Not runtime. |
| `screenshot/audit-analytics.png` | UI audit screenshot | Historical UI audit | NO | Keep | Low | Artifact only. |
| `screenshot/audit-control-center.png` | UI audit screenshot | Historical UI audit | NO | Keep | Low | Artifact only. |
| `screenshot/audit-diagnostics.png` | UI audit screenshot | Historical UI audit | NO | Keep | Low | Artifact only. |
| `screenshot/audit-live-monitor-active.png` | UI audit screenshot | Historical UI audit | NO | Keep | Low | Artifact only. |
| `screenshot/audit-live-monitor-idle.png` | UI audit screenshot | Historical UI audit | NO | Keep | Low | Artifact only. |
| `screenshot/audit-live-readiness.png` | UI audit screenshot | Historical UI audit | NO | Keep | Low | Artifact only. |
| `screenshot/audit-settings.png` | UI audit screenshot | Historical UI audit | NO | Keep | Low | Artifact only. |
| `screenshot/audit-strategy-lab-results.png` | UI audit screenshot | Historical UI audit | NO | Keep | Low | Artifact only. |
| `screenshot/strategy-lab-result.png` | UI screenshot | Historical UI audit | NO | Keep | Low | Artifact only. |
| `scripts/audit-connectivity.ts` | Tried multiple auth/signature paths | Debugging experiment | NO | Removed from active scripts | High | Could revive obsolete wallet/auth debate. Local ignored archive copy retained. |
| `scripts/btc-5m-market.ts` | Reusable BTC 5m tradable market resolver | Acceptance support | PARTIAL | Keep | Low | Useful harness guard; production uses equivalent slot/Gamma/CLOB path separately. |
| `scripts/check-balance.ts` | Balance diagnostic | Verification support | PARTIAL | Keep | Low | Safe, intentional diagnostic. |
| `scripts/check-clob.ts` | CLOB auth/open-order diagnostic | Verification support | PARTIAL | Hardened | Medium | Replaced dummy-market open-order check with all-open-orders query. |
| `scripts/credential-ambiguity-diagnostic.ts` | Official derivation and credential-source diagnostic | Final proof and guard | YES | Keep | Low | Prints key ID only; clears static credential ambiguity. |
| `scripts/final-acceptance-test.ts` | Live post/cancel acceptance harness | Final proof | YES | Keep, refactored helper | Medium | Now uses shared CLOB response failure helper. |
| `scripts/probe-wallets.ts` | Wallet probe | Debugging experiment | NO | Removed from active scripts | Medium | No ongoing value after official derivation. Local ignored archive copy retained. |
| `scripts/test-order.ts` | One-off static-credential order poster | Debugging experiment | NO | Removed from active scripts | High | Required static `POLY_API_*`, contradicted final auth model, and could mislead future runs. |
| `scripts/verify-raw-order.ts` | Raw Type 3 order assertion | Regression guard | YES | Keep | Low | Confirms maker/signer/signature/order version on production client path. |
| `setup_env.py` | Added auth fields during incident | Setup surface drift | PARTIAL | Hardened | Medium | Removed static `POLY_API_*` fields and defaulted signature type to Type 3. |
| `tsconfig.json` | Excludes `scripts/archive` | Quarantine support | PARTIAL | Keep | Low | Prevents archived probes from affecting typecheck. |
| `utils/fetch-retry.ts` | Curl availability diagnostic | Operational hardening | NO | Keep | Low | Helps explain fetch fallback failures. |

## Classification

### Bucket A: Essential Final Fix

- `engine/client.ts` Type 3 auth/trading client behavior.
- `.env.sample` and handoff docs identifying the correct owner-specific deposit wallet.
- `scripts/credential-ambiguity-diagnostic.ts`, `scripts/verify-raw-order.ts`, `scripts/final-acceptance-test.ts`.
- `@polymarket/builder-relayer-client@0.0.9` for official `deriveDepositWallet(...)`.

### Bucket B: Useful Hardening

- `scripts/btc-5m-market.ts` as a reusable acceptance resolver.
- Shared CLOB response helper: `.error`, `success:false`, and `status >= 400` are failures.
- `check-clob.ts` all-open-orders query.
- Timer typing, user-channel parse warnings, curl diagnostics, stricter execution-quality limits.

### Bucket C: Debugging Residue

- Removed active `scripts/audit-connectivity.ts`, `scripts/probe-wallets.ts`, and `scripts/test-order.ts`.
- Kept ignored local archive copies under `scripts/archive/2026-05-type3-debug` for archaeology only.

### Bucket D: Questionable / Regressive Changes

- `engine/early-bird.ts` had relaxed predictive divergence threshold from $50 to $150. This was not required for Type 3 auth and could weaken strategy gating, so it was reverted to the aggregator default.
- `setup_env.py` exposed static `POLY_API_*` as a bypass. This contradicted the final account model, so it was removed from the setup UI and generated `.env`.
- `check-clob.ts` queried a dummy condition ID, which could falsely imply global open orders were zero. It now uses `client.clob.getOpenOrders()`.
- `DefaultPredictiveAggregator` and `DefaultQuantMonitor` assumed every runtime resolution adapter object had `latestAnchor()`. Some older/mocked adapters did not, which caused asynchronous test contamination and could make observability brittle. Both now fail closed to `anchor=null` instead of throwing.

## Production Runtime Call Path

- Runtime entrypoint: `index.ts`
- Session orchestration: `SessionManager`
- Bot runtime: `EarlyBird`
- Client initialization: `EarlyBird` constructs `PolymarketEarlyBirdClient`, then calls `client.init()`.
- Credential path: `PolymarketEarlyBirdClient.init()` creates a signer-only `ClobClient` and calls `createOrDeriveApiKey(POLY_API_KEY_NONCE || 1)`. Static `POLY_API_*` / `BUILDER_*` values are not used for CLOB auth.
- Trading client path: `PolymarketEarlyBirdClient.init()` creates the trading `ClobClient` with the owner signer, fresh creds, `signatureType`, and `funderAddress`.
- Market-resolution path: `EarlyBird` computes slot slug with `getSlug(...)`; `MarketLifecycle.setup()` uses `PolymarketVenueAdapter.initRound()` and `APIQueue.queueEventDetails(...)` to resolve condition/token IDs and then subscribes orderbooks.
- Order-build path: strategies call `ctx.postOrders`; `MarketLifecycle._placeWithRetry()` applies risk gate then calls `client.postMultipleOrders`; `PolymarketEarlyBirdClient.postMultipleOrders()` builds order version `2` through `clob.orderBuilder.buildOrder(...)`.
- Order-post path: `PolymarketEarlyBirdClient.postMultipleOrders()` calls `clob.postOrders(...)`.
- Open-order/cancel path: lifecycle recovery and cleanup call `getOpenOrderIds(...)`, `cancelOrder(...)`, and `cancelOrders(...)` on the same production client.

Answer: YES, the actual production order/auth path uses the same proven Type 3 client path as the acceptance harness. The BTC 5m helper used by the harness is separate, but the runtime uses the same slot/Gamma/CLOB ingredients through `MarketLifecycle` and `PolymarketVenueAdapter`.

## Config / Secret Hygiene

- `.env.sample` documents that the `0x9bB7...` funder is specific to the proven owner and must be derived for other owners.
- `setup_env.py` no longer writes static `POLY_API_KEY`, `POLY_API_SECRET`, or `POLY_API_PASSPHRASE`.
- `engine/client.ts` still reads `POLY_API_KEY_NONCE`, but does not read static CLOB API key/secret/passphrase.
- Secret search found no live private key or CLOB secret in tracked source. Matches were dummy test keys, order IDs, historical notes, blank sample env keys, and archived scripts referencing environment variable names.

## Verification Record

- `npm run check`: PASS.
- Guardrail tests: PASS, `7 pass / 0 fail`.
  - `bun test test/engine/type3-account-model.test.ts test/utils/clob-response.test.ts`
- Relevant regression suite: PASS, `101 pass / 2 skip / 0 fail`.
  - `bun test --max-concurrency=1 test/engine/auth-hardening.test.ts test/engine/early-bird.test.ts test/engine/market-lifecycle.test.ts test/engine/polymarket-venue-adapter.test.ts test/engine/risk-gate-integration.test.ts test/engine/strategies.test.ts test/engine/replay.test.ts test/tracker/api-queue.test.ts test/tracker/orderbook.test.ts test/utils/config.test.ts test/utils/slot.test.ts test/utils/fetch-retry.test.ts`
- Isolated OrderBook suite after compatibility hardening: PASS, `17 pass / 0 fail`.
  - `bun test test/tracker/orderbook.test.ts`
- Full `bun test --max-concurrency=1`: mostly pass but still FAILS on the known full-suite OrderBook mock-isolation problem, `289 pass / 7 skip / 15 fail`. The same OrderBook file passes in isolation and in the relevant post-incident suite. This is test-harness isolation debt, not evidence of a Type 3 runtime regression.
- `git diff --check`: PASS.

## Guardrails Added

- `test/engine/type3-account-model.test.ts`
  - Verifies official deposit-wallet derivation for the owner.
  - Verifies offline Type 3 order builder uses deposit wallet as maker/signer and `signatureType=3`.
  - Verifies sample config does not assign old wrong funders as live `POLY_FUNDER_ADDRESS`.
  - Verifies setup UI does not offer static CLOB API credentials.
  - Verifies production client does not read static `POLY_API_KEY`, `POLY_API_SECRET`, or `POLY_API_PASSPHRASE`.
- `test/utils/clob-response.test.ts`
  - Verifies CLOB `{ error, status: 400 }`, `status >= 400`, and `success:false` responses are failures.
- `utils/clob-response.ts`
  - Shared response interpretation for acceptance and future CLOB calls.

## Remaining Risks

- The full live exchange path was not re-posted during this stabilization pass by design; the accepted live order proof remains from `e17796a`.
- Execution-quality defaults changed during the incident and are kept because they are safer, but they are a behavior policy change and should be considered during future runtime validation.
- Full all-file Bun test still exposes a known OrderBook mock-isolation issue. The OrderBook suite passes alone and in the targeted regression sweep, so this is tracked as test-harness debt rather than an active runtime regression.
- Archived scripts remain locally under an ignored directory for archaeology; they should not be used as active diagnostics.
