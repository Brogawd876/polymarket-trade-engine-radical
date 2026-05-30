import { StrategyLabBatchManager } from "../engine/strategy-lab.ts";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";

async function main() {
  const manager = new StrategyLabBatchManager();
  const pairsDir = "data/pairs";
  const maxPairs = 25;

  const pairFiles = readdirSync(pairsDir)
    .filter(f => f.endsWith(".pair.json"))
    .slice(0, maxPairs);

  const files = pairFiles.map(f => {
    const manifest = JSON.parse(readFileSync(path.join(pairsDir, f), "utf8"));
    return manifest.replayLogPath;
  });

  const l2Files: Record<string, string> = {};
  for (const f of pairFiles) {
    const manifest = JSON.parse(readFileSync(path.join(pairsDir, f), "utf8"));
    l2Files[manifest.replayLogPath] = manifest.rawL2LogPath;
  }

  console.log("Running Independent Rerolls Batch...");
  const independentBatch = await manager.createBatch({
    variants: ["fvm-v1.1.0-raw-ungated"],
    files,
    l2Files,
    riskMode: "normal",
    continuousBankroll: false,
  });

  console.log("Running Continuous Bankroll Batch...");
  const continuousBatch = await manager.createBatch({
    variants: ["fvm-v1.1.0-raw-ungated"],
    files,
    l2Files,
    riskMode: "normal",
    continuousBankroll: true,
  });

  async function waitForBatch(batchId: string) {
    while (true) {
      const b = manager.getBatch(batchId);
      if (b?.state === "completed" || b?.state === "failed" || b?.state === "canceled") return b;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const [indepResult, contResult] = await Promise.all([
    waitForBatch(independentBatch.id),
    waitForBatch(continuousBatch.id),
  ]);

  // Extract sequential PnL data
  let indepRunningPnl = 50; // Starting balance
  const indepData = [50];
  const indepLabels = ["Start"];
  
  for (let i = 0; i < indepResult.runs.length; i++) {
    const run = indepResult.runs[i];
    if (!run) continue;
    indepRunningPnl += (run.pnl ?? 0);
    indepData.push(indepRunningPnl);
    indepLabels.push(`R${i + 1}`);
  }

  let contRunningPnl = 50; // Starting balance
  const contData = [50];
  
  for (let i = 0; i < contResult.runs.length; i++) {
    const run = contResult.runs[i];
    if (!run) continue;
    contRunningPnl += (run.pnl ?? 0);
    contData.push(contRunningPnl);
  }

  const html = `<!DOCTYPE html>
<html>
<head>
    <title>PnL Trajectory Comparison</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: -apple-system, sans-serif; padding: 20px; background: #1e1e2e; color: #cdd6f4; }
        .chart-container { position: relative; height: 60vh; width: 80vw; margin: auto; }
        h1 { text-align: center; color: #89b4fa; }
        .description { text-align: center; max-width: 800px; margin: 0 auto 30px auto; color: #a6adc8; line-height: 1.5; }
    </style>
</head>
<body>
    <h1>Strategy Trajectory: Independent Rerolls vs Continuous Bankroll</h1>
    <div class="description">
        This chart tracks the cumulative wallet balance of <b>v1.1.0 Raw</b> over 25 consecutive market pairs.<br><br>
        <b style="color: #a6e3a1;">Green Line (Independent Rerolls):</b> Starts every single round with exactly $50. Win or lose, it gets reset. This shows the strategy's pure theoretical edge without capital constraints.<br>
        <b style="color: #f38ba8;">Red Line (Continuous Bankroll):</b> Starts with $50 on Round 1 and carries the balance forward. Notice how a few bad rounds early on bankrupt the wallet, preventing it from trading the later profitable rounds.
    </div>
    <div class="chart-container">
        <canvas id="pnlChart"></canvas>
    </div>

    <script>
        const ctx = document.getElementById('pnlChart').getContext('2d');
        const labels = ${JSON.stringify(indepLabels)};
        const indepData = ${JSON.stringify(indepData)};
        const contData = ${JSON.stringify(contData)};

        new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Independent Rerolls ($50 reset)',
                        data: indepData,
                        borderColor: '#a6e3a1',
                        backgroundColor: 'rgba(166, 227, 161, 0.1)',
                        borderWidth: 3,
                        pointRadius: 4,
                        fill: true,
                        tension: 0.2
                    },
                    {
                        label: 'Continuous Bankroll (No reset)',
                        data: contData,
                        borderColor: '#f38ba8',
                        backgroundColor: 'rgba(243, 139, 168, 0.1)',
                        borderWidth: 3,
                        pointRadius: 4,
                        fill: true,
                        tension: 0.2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return context.dataset.label + ': $' + context.parsed.y.toFixed(2);
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        title: { display: true, text: 'Wallet Balance ($)', color: '#cdd6f4' },
                        grid: { color: '#313244' },
                        ticks: { color: '#a6adc8' },
                        min: 0
                    },
                    x: {
                        title: { display: true, text: 'Market Pair (Chronological)', color: '#cdd6f4' },
                        grid: { color: '#313244' },
                        ticks: { color: '#a6adc8' }
                    }
                }
            }
        });
    </script>
</body>
</html>`;

  writeFileSync("../AI_WORKSPACE/pnl_comparison_chart.html", html);
  console.log("Chart generated at AI_WORKSPACE/pnl_comparison_chart.html");
}

main().catch(console.error);
