# Workspace Map

```text
Polymarket-Deck-Lab/
├── AGENTS.md
├── GEMINI.md
├── .gemini/
│   └── settings.json
├── .agents/
│   ├── rules/
│   │   ├── 00-workspace-continuity.md
│   │   └── 10-safety-and-trading-boundaries.md
│   └── workflows/
│       ├── resume.md
│       └── handoff.md
├── AI_WORKSPACE/
│   ├── PROJECT_BRIEF.md
│   ├── WORKSPACE_MAP.md
│   ├── ACTIVE_TASK.md
│   ├── HANDOFF.md
│   ├── DECISIONS.md
│   ├── ENVIRONMENT.md
│   ├── COMMANDS.md
│   ├── SETUP_AUDIT.md
│   └── SESSION_LOG.md
├── scripts/
│   ├── check-env.ps1
│   ├── workspace-status.ps1
│   └── bootstrap-summary.ps1
└── repos/
    ├── polyterm/
    ├── polyrec/
    └── polymarket-trade-engine/
```

## Repository Roles

- `repos/polyterm`: Polymarket terminal/CLI candidate for market exploration or operator workflows.
- `repos/polyrec`: Research/reference project to audit for recommendation logic, data requirements, and missing dependencies.
- `repos/polymarket-trade-engine`: Candidate base for execution, simulation, strategy, and trading-engine architecture.

## Shared Documentation

All shared agent state and audit notes live under `AI_WORKSPACE/`.

Agents should be launched from the `Polymarket-Deck-Lab` root, not from inside repositories under `repos/`.

