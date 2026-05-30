# Commands

Only documented or verified commands should be added here.

## Workspace

```powershell
cd C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab
powershell -ExecutionPolicy Bypass -File .\scripts\check-env.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\workspace-status.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-summary.ps1
```

## Enter Repositories

```powershell
cd C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polyterm
cd C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polyrec
cd C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polymarket-trade-engine
```

## Repository Install/Test/Smoke Commands

### polyterm

Documented install commands:

```powershell
cd C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polyterm
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
```

Verified smoke commands:

```powershell
.\.venv\Scripts\polyterm.exe --version
.\.venv\Scripts\polyterm.exe --help
.\.venv\Scripts\python.exe -m pytest tests\test_cli\test_command_inventory.py -q
```

### polyrec

Documented install commands:

```powershell
cd C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polyrec
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Verified smoke command:

```powershell
.\.venv\Scripts\python.exe -m py_compile dash.py replicate_balance.py fade_impulse_backtest.py visualize_fade_impulse.py
```

Documented runtime commands, not fully smoke-tested because they require live network streams and/or missing files:

```powershell
.\.venv\Scripts\python.exe dash.py
.\.venv\Scripts\python.exe replicate_balance.py
.\.venv\Scripts\python.exe fade_impulse_backtest.py
.\.venv\Scripts\python.exe visualize_fade_impulse.py
```

### polymarket-trade-engine

Documented install/runtime commands:

```powershell
cd C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polymarket-trade-engine
bun install
bun run index.ts --strategy simulation --rounds 10
bun run index.ts --strategy late-entry --rounds 5
bun run scripts\orderbook.ts --asset btc --window 5m
cd analysis
bun install
bun run dev
```

Verified syntax-only check that did not require Bun dependencies:

```powershell
node --check index.ts
```

Verified Bun checks:

```powershell
$env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
bun install
bun run index.ts --help
bun run index.ts --rounds 0
bun run index.ts --strategy simulation --rounds 1 --always-log
bun run scripts\chart.ts logs\early-bird-btc-updown-5m-1778891400.log
```

Analysis dashboard:

```powershell
cd C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polymarket-trade-engine\analysis
$env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
bun install
bun run normalize:runs
bun run check
bun run build
```

Known failing checks on this Windows setup:

```powershell
cd C:\Users\Yasser\Documents\trade\Polymarket-Deck-Lab\repos\polymarket-trade-engine
$env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
bun run check
bun test
```

`bun run check` from the repo root fails because the root TypeScript build includes `analysis/` browser code without DOM libs. `bun test` currently has one live Binance WebSocket timeout and Windows path/import issues in `test\utils\process-lock.test.ts`.
