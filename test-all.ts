import { StrategyLabBatchManager } from "./engine/strategy-lab.ts";
import { readdirSync } from "fs";

async function runDataset(label: string, files: string[], variants: string[]) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"=".repeat(60)}\n`);

  const manager = new StrategyLabBatchManager();
  const batch = await manager.createBatch({
    variants,
    files,
    continuousBankroll: true,
  });

  let current = manager.getBatch(batch.id);
  while (current && (current.state === "queued" || current.state === "running")) {
    await new Promise(r => setTimeout(r, 1000));
    current = manager.getBatch(batch.id);
    if (current) {
      process.stdout.write(`\rProgress: ${current.progress.completedRuns} / ${current.progress.totalRuns}`);
    }
  }
  console.log("");

  if (!current) { console.log("Batch not found?"); return; }

  console.log("\n--- STRATEGY LAB RESULTS ---");
  for (const v of current.summary.byStrategy) {
    console.log(`Variant: ${v.label} | PnL: $${v.totalPnl.toFixed(4).padStart(10)} | Wins: ${v.wins} | Losses: ${v.losses} | Fills: ${v.conservativeFill?.eligibleFillCount ?? "N/A"}`);
  }

  console.log("\n--- PER-FILE ANALYSIS ---");
  for (const file of files) {
    console.log(`\nMarket File: ${file}`);
    for (const run of current.runs) {
      if (run.file === file) {
        const pnl = run.pnl ?? 0;
        console.log(`  - ${run.variantLabel}: $${pnl.toFixed(4)}`);
      }
    }
  }
}

async function run() {
  const allFiles = readdirSync("logs")
    .filter(f => f.startsWith("early-bird-btc-updown") && f.endsWith(".log"))
    .sort()
    .map(f => `logs/${f}`);

  const variants = [
    // NEW v4.0.0 series (fair-value-maker engine)
    "fvm-v4.0.0-alpha",
    "fvm-v4.0.1-alpha-strict",
    "fvm-v4.0.2-alpha-conservative",
    // Proven references
    "fvm-v1.1.1-turbo",
    "fvm-v3.0.0-momentum-gated",
    // Old baselines
    "fvm-v1.5.0-avellaneda",
    "fvm-v3.1.0-avellaneda-momentum",
  ];

  await runDataset("DATASET A: OLD SIMULATION (files 1-10)", allFiles.slice(0, 10), variants);
  await runDataset("DATASET B: FRESH SIMULATION (files 11-20)", allFiles.slice(10, 20), variants);
}

run().catch(console.error);
