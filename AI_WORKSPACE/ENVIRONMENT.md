# Environment

Generated from `scripts/check-env.ps1` on 2026-05-15T20:23:10-04:00.

Direct script execution is currently blocked by PowerShell execution policy. Use the process-local bypass form:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-env.ps1
```

## Found

| Tool | Version / Status |
|---|---|
| Git | 2.53.0.windows.2 |
| Windows PowerShell | 5.1.26100.8457 |
| Python | 3.13.12 |
| pip | 25.3 for Python 3.13 |
| Node.js | v24.14.1 |
| npm | 11.11.0 |
| Bun | 1.3.14 at `C:\Users\Yasser\.bun\bin\bun.exe` |
| Codex CLI | codex-cli 0.130.0-alpha.5 |
| Gemini CLI | 0.42.0 |
| Google Antigravity | Possible install found at `C:\Users\Yasser\AppData\Local\Programs\Antigravity`; GUI app installation cannot be fully verified from this script. |

## Missing or Needs User Install

- `pipx`: Recommended by PolyTerm's README for PyPI install (`pipx install polyterm`), but not required for the local editable install already performed in `repos/polyterm\.venv`.
- `uv`: Optional. Not required by any audited repo so far.
- `docker`: Optional. Not required by the audited setup commands so far.

## Local Project Environments

- `repos/polyterm\.venv`: created; `pip install -e .` completed successfully.
- `repos/polyrec\.venv`: created; `pip install -r requirements.txt` completed successfully.
- `repos/polymarket-trade-engine`: `bun install` completed successfully.
- `repos/polymarket-trade-engine\analysis`: `bun install` completed successfully.

## Notes

- Git may report "dubious ownership" when checking nested repositories from the sandboxed Codex user. `scripts/workspace-status.ps1` uses a command-local `safe.directory` override for status checks and does not change global Git config.
- Restart terminals/editors if `bun` is not found by name. Current audited install path is `C:\Users\Yasser\.bun\bin\bun.exe`.
