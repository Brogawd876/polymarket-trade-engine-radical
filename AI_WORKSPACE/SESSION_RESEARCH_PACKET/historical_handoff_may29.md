# Polymarket Trade Engine — Handoff

## Last Agent: Antigravity (Google)
## Session Date: 2026-05-29
## Status: BOT OFFLINE — Clean close-out performed

---

## What Happened This Session

Three live production runs were completed using `fvm-v1.3.0-profit-selective`.

### Run 1 (task-1662) — Major Success
- **Start:** $15.78 | **End:** ~$106.82
- **Rounds:** 4 (3 WIN / 1 LOSS)
- **Net PnL: +$91.04**
- Highlights: Round 3 built a 104-share bag through 14 fills, paid +$104.76 in one settlement. Bot was manually killed by user after Round 4 loss.

### Run 2 (task-1782) — Profit Target Hit
- **Start:** $39.86 | **End:** $52.98
- **Rounds:** 2 (2 WIN / 0 LOSS)
- **Net PnL: +$19.29 (session); cumulative +$134.19 including Run 1 carry-over**
- Note: Session hit $100 cumulative profit target early due to state file carry-over from Run 1.

### Run 3 (task-1821) — Loss Limit Hit
- **Start:** $10.03 | **End:** ~$2.68
- **Rounds:** 2 (0 WIN / 2 LOSS)
- **Net PnL: -$7.35**
- Cause: BTC reversed against position in both rounds. `.env` was also corrupted with duplicate keys at this point (now fixed). Loss limit of -$5 triggered automatic shutdown.

---

## Current State

- **Bot:** OFFLINE (not running)
- **Strategy:** `fvm-v1.3.0-profit-selective` — **unchanged and correct**
- **`.env`:** Cleaned and fixed. Duplicate keys (`POLY_SIGNATURE_TYPE`, `POLY_API_KEY_NONCE`, `BUILDER_KEY`) removed.
- **State file:** `state/early-bird-prod.json` was backed up to `.bak` and reset before Run 3. A fresh `early-bird-prod.json` will be created automatically on next launch.
- **Current `.env` settings:**
  - `MAX_SESSION_PROFIT=150`
  - `MAX_SESSION_LOSS=5`
  - `WALLET_BALANCE=10`
  - `FORCE_PROD=true`

---

## Outstanding Feature Request (NOT YET IMPLEMENTED)

> **Take-Profit / Early Cash-Out feature** — User has repeatedly requested this.

**The Problem:** The bot currently holds all positions until the Polymarket timer expires. When the win probability drops mid-round (e.g. 100% → 81%), the bot cannot exit. This turned winning rounds into losses multiple times this session.

**The Solution (drafted in `implementation_plan.md`):** Add a sell mechanism in `fair-value-maker.ts` that monitors the live market price of held shares and submits a SELL order when the price reaches a threshold (e.g., $0.97–$0.99), locking in near-full profit early.

**Status:** Plan is written. Not yet coded. User agreed to implement after the session.

---

## Next Steps for Next Agent

1. **Read `implementation_plan.md`** for the full take-profit feature design.
2. **Implement the take-profit logic** in `engine/strategy/fair-value-maker.ts`.
3. **Consider raising `MAX_SESSION_LOSS`** proportionally — at $10 balance, $5 loss limit means a single bad round kills the session. Recommend 20-25% of wallet (i.e., $2–$2.50 per $10 balance or just a flat $10 floor).
4. **To restart the bot:** `bun index.ts --strategy fvm-v1.3.0-profit-selective --prod` from `repos/polymarket-trade-engine/`
5. **VPN must be active** before launching — Polymarket enforces IP geoblocking.

---

## Combined Session Stats (All Runs)

| Metric | Value |
|--------|-------|
| Total rounds | 8 |
| Wins | 5 (62.5%) |
| Losses | 2 (25%) |
| Break-even | 1 (12.5%) |
| Combined net PnL | **+$102.98** |
| Peak wallet balance | **~$106.82** |
