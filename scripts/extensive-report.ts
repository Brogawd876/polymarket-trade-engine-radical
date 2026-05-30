import { StrategyLabBatchManager } from "../engine/strategy-lab.ts";
import { readdirSync, writeFileSync } from "fs";

async function runExtensiveAnalysis() {
  process.env.WALLET_BALANCE = "10";
  const manager = new StrategyLabBatchManager();
  
  // Get all early bird BTC updown logs, sort them chronologically
  const files = readdirSync("logs")
    .filter(f => f.startsWith("early-bird-btc-updown-5m") && f.endsWith(".log"))
    .sort() // important for continuous bankroll chronological sequence
    .map(f => `logs/${f}`);
    
  const variant = "fvm-v2.1.1-safeguarded";
      
  console.log(`Running continuous simulation on ${files.length} market files.`);
  console.log(`Wallet Balance Initialized: $10.00`);
  console.log(`Variant: ${variant}`);

  const batch = await manager.createBatch({
    variants: [variant],
    files: files,
    continuousBankroll: true,
  });
  
  console.log(`Batch ${batch.id} started. Waiting for completion...`);

  // Wait loop
  let currentBatch = manager.getBatch(batch.id);
  while (currentBatch && (currentBatch.state === "queued" || currentBatch.state === "running")) {
      await new Promise(r => setTimeout(r, 2000));
      currentBatch = manager.getBatch(batch.id);
      if (currentBatch) {
        process.stdout.write(`\rProgress: ${currentBatch.progress.completedRuns} / ${currentBatch.progress.totalRuns}`);
      }
  }
  console.log("\nSimulation Complete.");
  
  if (!currentBatch) return;

  const runs = currentBatch.runs;
  let currentBalance = 10;
  let peakBalance = 10;
  let maxDrawdown = 0;
  
  let totalWins = 0;
  let totalLosses = 0;
  let totalWinPnL = 0;
  let totalLossPnL = 0;
  
  const lossDetails: any[] = [];
  
  // Sort runs to ensure chronological
  runs.sort((a, b) => a.file.localeCompare(b.file));
  
  for (const run of runs) {
    if (run.pnl === null) continue;
    
    currentBalance += run.pnl;
    
    if (currentBalance > peakBalance) {
        peakBalance = currentBalance;
    }
    const drawdown = peakBalance - currentBalance;
    if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
    }
    
    if (run.pnl > 0) {
        totalWins++;
        totalWinPnL += run.pnl;
    } else if (run.pnl < 0) {
        totalLosses++;
        totalLossPnL += run.pnl;
        lossDetails.push({
            file: run.file,
            pnl: run.pnl,
            balanceAfterLoss: currentBalance
        });
    }
  }
  
  const report = {
      startingBalance: 10,
      endingBalance: currentBalance,
      netPnL: currentBalance - 10,
      peakBalance,
      maxDrawdown,
      metrics: {
          totalTrades: totalWins + totalLosses,
          wins: totalWins,
          losses: totalLosses,
          winRate: totalWins / (totalWins + totalLosses) || 0,
          averageWin: totalWins > 0 ? totalWinPnL / totalWins : 0,
          averageLoss: totalLosses > 0 ? totalLossPnL / totalLosses : 0,
      },
      lossDetails: lossDetails
  };
  
  writeFileSync("extensive_report.json", JSON.stringify(report, null, 2));
  console.log("\n--- Extensive Report ---");
  console.log(`Starting PnL: $10.00`);
  console.log(`Ending PnL (Balance): $${report.endingBalance.toFixed(2)}`);
  console.log(`Net Profit: $${report.netPnL.toFixed(2)}`);
  console.log(`Win Rate: ${(report.metrics.winRate * 100).toFixed(2)}% (${report.metrics.wins} Wins / ${report.metrics.losses} Losses)`);
  console.log(`Average Gain: $${report.metrics.averageWin.toFixed(2)}`);
  console.log(`Average Loss: $${report.metrics.averageLoss.toFixed(2)}`);
  console.log(`Max Drawdown: $${report.maxDrawdown.toFixed(2)}`);
  
  // Also print the worst 3 losses
  const worstLosses = [...lossDetails].sort((a, b) => a.pnl - b.pnl).slice(0, 5);
  console.log("\nWorst Losses:");
  for (const loss of worstLosses) {
      console.log(`  - ${loss.file}: lost $${Math.abs(loss.pnl).toFixed(2)} (Balance dropped to $${loss.balanceAfterLoss.toFixed(2)})`);
  }
  
}

runExtensiveAnalysis().catch(console.error);
