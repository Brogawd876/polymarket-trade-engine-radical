import { StrategyLabBatchManager } from "./engine/strategy-lab.ts";
import { listStrategyVariants } from "./engine/strategy/index.ts";
import { readdirSync } from "fs";

async function run() {
  const manager = new StrategyLabBatchManager();
  
  const files = readdirSync("logs")
    .filter(f => f.startsWith("early-bird-btc-updown") && f.endsWith(".log"))
    .map(f => `logs/${f}`)
    .slice(0, 10);
    
  const variants = [
    "fvm-v2.0.0-toxic-guarded-50",
    "fvm-v2.1.0-advanced-exits-maker",
    "fvm-v2.1.0-advanced-exits-taker"
  ];
      
  console.log("Running variants:", variants);
  console.log(`Running on ${files.length} market files.`);

  const batch = await manager.createBatch({
    variants: variants,
    files: files,
    continuousBankroll: true,
  });
  
  console.log(`Batch ${batch.id} started. Waiting for completion...`);

  // Simple wait loop
  let currentBatch = manager.getBatch(batch.id);
  while (currentBatch && (currentBatch.state === "queued" || currentBatch.state === "running")) {
      await new Promise(r => setTimeout(r, 1000));
      currentBatch = manager.getBatch(batch.id);
      if (currentBatch) {
        process.stdout.write(`\rProgress: ${currentBatch.progress.completedRuns} / ${currentBatch.progress.totalRuns}`);
      }
  }
  console.log("");
  
  if (!currentBatch) {
      console.log("Batch not found?");
      return;
  }

  console.log("\n--- STRATEGY LAB RESULTS ---");
  for (const v of currentBatch.summary.byStrategy) {
    console.log(`Variant: ${v.label.padEnd(30)} | PnL: $${v.totalPnl.toFixed(4).padStart(8)} | Wins: ${v.wins} | Losses: ${v.losses} | Fills: ${v.conservativeFill?.eligibleFillCount ?? "N/A"}`);
  }

  console.log("\n--- PER-FILE ANALYSIS ---");
  for (const file of files) {
    console.log(`\nMarket File: ${file}`);
    for (const run of currentBatch.runs) {
      if (run.file === file) {
        const pnl = run.pnl ?? 0;
        const color = pnl > 0 ? "\x1b[32m" : (pnl < 0 ? "\x1b[31m" : "\x1b[90m");
        console.log(`  - ${run.variantLabel.padEnd(30)}: ${color}$${pnl.toFixed(4)}\x1b[0m`);
      }
    }
  }
}

run().catch(console.error);
