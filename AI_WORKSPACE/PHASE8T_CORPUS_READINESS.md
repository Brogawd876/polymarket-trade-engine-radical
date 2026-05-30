# Phase 8T Corpus Readiness Report

## 1. Capture Result
- **Attempts**: 1 (during this session)
- **Valid pairs**: 6 (total)
- **Invalid pairs**: 5 (total)
- **Failed captures**: 0
- **Total raw L2 events**: ~1.88 million (across all pairs)
- **Total raw L2 trade events**: 14,880
- **Recorder stop reasons**: `completed` for recent captures, `unknown` for some older captures.

## 2. Pipeline Result
- **Total calibration records**: 1,458
- **Labeled record count**: 900
- **Missing label count**: 558
- **Trade-print-backed count**: 900
- **Touch-only count**: 558
- **No-fill count**: 0
- **Readiness decision**: blocked
- **Global failures**:
  - Total records (1458) is below required minimum (5000).
  - Trade-print-backed records (900) is below required minimum (2000).
- **Top blockers**:
  - Minimum total/labeled record thresholds are not met.
  - Split mode is `row` instead of `temporal`.
  - For `temporal` splits, the holdout sample count (150) is below the required minimum (200).

## 3. Safety Confirmation
- **No live execution behavior changed**: Confirmed.
- **No live risk gates changed**: Confirmed.
- **No order placement behavior changed**: Confirmed.
- **No generated artifacts committed**: Confirmed.

## 4. Next Action
Readiness is currently BLOCKED. The exact next collection targets are:
- **Target valid pair count**: Need ~25 total valid pairs (19 more).
- **Target trade-print-backed records**: Need 2000 (1100 more).
- **Temporal spread needed**: Must capture data over multiple distinct hours/days to ensure `temporal` split holdout count exceeds 200.
- **Recorder quality**: Acceptable (capturing >100k events and ~3k trade prints per round).
- **Capture continuity**: Capture should continue safely in the background or via scheduled runs until the targets are met.
