# AI Feature Development Git Protocol

This document defines the mandatory Git discipline for all work in this workspace going forward.

## 1. Task Initialization
Before starting any new feature or fix:
- Create a dedicated feature branch from the latest clean baseline.
- **Branch naming convention**: `feat/description` or `fix/description` (e.g., `feat/telemetry-ui`).
- Record the current branch and status in the session log.

## 2. Dirty Tree Policy
- No new major task should begin from a large dirty working tree.
- If uncommitted work exists from a previous task, checkpoint it first or isolate it.

## 3. Incremental Validation
- Commit after every logical milestone that passes local validation (tests, typecheck).
- Do not accumulate massive multi-file diffs before the first commit.

## 4. Commit Standards
- **Messages**: Describe the specific slice precisely (e.g., `feat(telemetry): add discriminated TelemetryEvent union`).
- **Validation**: Every commit should ideally represent a state that passes relevant tests.

## 5. Handoff & Continuity
Every handoff MUST include:
- **Branch Name**: The active branch.
- **Latest Commit**: The short hash of the latest validated milestone.
- **Tree Status**: `CLEAN` or `DIRTY` (with a list of intentionally uncommitted files).

## 6. Review & Merge
- Feature branches should be merged into `master` only after full regression testing.
- After a successful merge, the feature branch may be deleted.

---
*Established: 2026-05-16*
