# Strategic Alignment: Radical vs. Conservative

## The Conflict
There is a fundamental conflict between maintaining the legacy test suite's "Green" status and implementing the "Radical" performance overhaul.

### 1. Engine Heartbeat (The "Speed" Gap)
- **Radical Intent (Gemini CLI):** Move from 100ms to 10ms heartbeat to enable HFT-grade responsiveness and sub-100ms execution.
- **Conservative Action (Previous Agent):** Reverted to 100ms because the legacy tests (using Virtual Clocks) were failing due to timing race conditions.
- **Verdict:** Reverting to 100ms is a regression. We must fix the tests to support 10ms, not slow the engine down to support the tests.

### 2. Fill Realism (The "Truth" Gap)
- **Radical Intent (Gemini CLI):** Enforce strict trade-through evidence for all fills (Conservative Fill Scorer).
- **Conservative Action (Previous Agent):** Restored "Optimistic Fill Logic" (filling whenever price is touched) to satisfy legacy unit tests.
- **Verdict:** Optimistic fills lead to "backtest hallucinations." We must maintain high-fidelity matching even if it means rewriting how the tests assert on fills.

### 3. Predictive Pre-fetching
- **Radical Intent (Gemini CLI):** Pre-fetch market metadata for the next 30 minutes to ensure 0ms latency at the top of the round.
- **Status:** This feature was partially implemented but its utility is diminished if the engine is throttled at 100ms.

## Resolution Plan
1. **Re-Overclock:** Restore the 10ms heartbeat in `early-bird.ts` and `replay-runner.ts`.
2. **Harden Simulation:** Re-implement the virtual clock synchronization in `FixtureRunner` so it supports 10ms resolution without race conditions.
3. **Update Test Expectations:** Surgically update assertions in `market-lifecycle.test.ts` to reflect the reality of a high-speed engine (e.g., handling partial fills and faster state transitions).
4. **Deploy Radical Hybrid:** Proceed with benchmarking the new strategy using the high-fidelity engine.
