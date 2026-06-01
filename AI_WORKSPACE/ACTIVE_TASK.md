# ACTIVE_TASK

## Current Task
Close repair branch, clean the workspace for Codex/Antigravity/Gemini CLI, merge useful work, and prepare the next profitability-validation phase.

## Phase 5C Closeout Actions
- [x] Pre-validation of fixture files in corpus runner (resolved stalls due to invalid/pre-market fixtures).
- [x] 100% complete same-sample FVM lineage comparison run (995 total runs, 0 missing).
- [x] Verified FVM lineage comparison results (FVM v1.1.0 Raw/Ungated confirmed as benchmark, newer variants negative).
- [x] Archived stale or corrupted lineage reports under `AI_WORKSPACE/archive/`.
- [x] Stage and commit final Phase 5C lineage evidence harness & workspace docs.
- [/] Update workspace tracking files (`CURRENT_STATE.md`, `ACTIVE_TASK.md`, `DECISIONS.md`, `HANDOFF.md`).
- [x] Run final verification checking suite (`bun run check`, `bun test`, and UI linting/testing/building).
- [x] Archive root-level one-off repair scratch files under `AI_WORKSPACE/archive/repair-scratch-2026-06-01/`.
- [x] Add shared multi-agent orientation files (`AGENTS.md`, `GEMINI.md`).
- [x] Merge cleaned repair work into `master`.
- [x] Generate concise closeout report and recommend definitive branch action.

## Forbidden Next Work (Blocked in this Phase)
- No new FVM formula changes, strategy variants, or calibrations.
- No post-only order handling or adverse-selection shields.
- No UI enhancements, layout changes, or cockpits.
- No paper/live trading integration or replay timing optimizations.

## Next Profitability Phase
- Export missing risk and quality metrics.
- Run continuous-bankroll validation.
- Compare `fvm-v1.1.0-raw-ungated` against Avellaneda/momentum/calibrated candidates on broad same-sample and holdout evidence.
- Promote nothing until PnL, drawdown, fill realism, adverse selection, and trade count all survive conservative review.
