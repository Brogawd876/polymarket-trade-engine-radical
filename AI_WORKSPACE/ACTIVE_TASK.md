# Active Task

**Status:** Promising-strategy calibration pipeline run completed; readiness blocked.

**Current Objective:** Replay-stall classification is fixed; increase high-quality paired evidence before any calibration artifact or strategy promotion.

## Current State

- The repo has moved beyond Phase 9E. Dynamic percentage sizing and momentum-confirmed sizing exist in strategy code.
- The current documented champion in top-level `HANDOFF.md` is `fvm-v3.1.0-avellaneda-momentum`, based on a 10-file simulation result.
- Experimental strategy variants now extend through v5.0.0, including fee-aware Avellaneda calibration.
- A new explicit calibrated variant exists: `fvm-v5.1.0-avellaneda-isotonic`.
- The corpus calibration pipeline now defaults to lean streaming replay extraction instead of full-batch retention.
- Strategy Lab now supports lightweight progress polling and cached indexed raw L2 scoring.
- Calibration artifacts are generated only after readiness passes and are loaded fail-closed by calibrated variants.
- The promising-strategy run at `data/calibration-output/promising-2026-05-31` produced 894 combined records and no paper-candidate artifact.
- The least-bad strategy in that run was `fvm-v3.5.1-avellaneda-strict-gate`, but it still lost money and remains research-only.
- Lean calibration now records failed slugs/errors and skips known failed slugs on resume unless `--retry-failed` is used.
- Strategy Lab and lean calibration now fail fast on replay logs that end before market open without market-price or resolution data, avoiding generic replay stalls for incomplete premarket logs.
- The 10ms `ReplayRunner` heartbeat is active and is part of the radical fork intent.
- Type 3 live order semantics are proven and must not be regressed.

## Immediate Work Items

- [x] Evaluate whole project state, handoff docs, session log, and agent instructions.
- [x] Restore green `npm run check`.
- [x] Restore backend root `bun test` by excluding UI tests from root discovery.
- [x] Keep UI tests runnable from `ui/` with UI dependencies installed.
- [x] Update stale strategy tests for the current max-spend-cap behavior.
- [x] Reduce replay-runner console noise during tests while preserving explicit debug capability.
- [x] Update handoff/session logs after verification.
- [x] Implement efficient calibration-to-strategy pipeline plan.
- [x] Add low-memory Strategy Lab progress API.
- [x] Add cached token/time indexed raw L2 fill-scoring path with parity coverage.
- [x] Add calibration artifact generation and fail-closed artifact loading.
- [x] Add explicit calibrated Avellaneda variant and verification command.
- [x] Fix calibration log/memory bottleneck with quiet replay logging.
- [x] Add failed-slug resume checkpoints and `--allow-partial` calibration mode.
- [x] Run promising strategies through the lean calibration/audit/readiness pipeline.
- [x] Classify incomplete premarket replay logs before Strategy Lab/lean calibration execution.
- [x] Remove leftover lifecycle test debug output and gate replay adapter debug logs behind `REPLAY_DEBUG=true`.

## Next Exact Task

Latest verified checks:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run check
bun test test\engine\strategy-lab.test.ts test\engine\replay.test.ts test\engine\market-lifecycle.test.ts
bun test
cd ui; bun test
```

Next:

1. Optionally re-run lean calibration with `--retry-failed --allow-partial` to reclassify old failed-slug progress entries with explicit unresolved replay reasons.
2. Capture more temporally separated, trade-print-backed paired raw L2 data; current readiness is blocked at 894 / 5000 total records and 870 / 2000 trade-print-backed records.
3. Keep `fvm-v3.5.1-avellaneda-strict-gate` as the next research baseline, not as a paper/live candidate.
