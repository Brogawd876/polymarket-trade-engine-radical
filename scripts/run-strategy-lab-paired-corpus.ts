import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import { type PairManifest } from "../engine/replay/pair-manifest.ts";
import { StrategyLabBatchManager, type StrategyLabBatch, type StrategyLabVariantSummary } from "../engine/strategy-lab.ts";
import { extractCalibrationRecords } from "../engine/replay/calibration-extractor.ts";

import { shouldTimeout } from "./paired-corpus-utils.ts";

const MAX_BATCH_RUNS = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function sumNullable(values: Array<number | null | undefined>): number | null {
  const usable = values.filter((v): v is number => typeof v === "number");
  if (usable.length === 0) return null;
  return usable.reduce((acc, v) => acc + v, 0);
}

function avgNullable(values: Array<number | null | undefined>): number | null {
  const sum = sumNullable(values);
  if (sum === null) return null;
  return sum / values.filter((v): v is number => typeof v === "number").length;
}

function combineVariantSummaries(summaries: StrategyLabVariantSummary[]): StrategyLabVariantSummary[] {
  const byLabel = new Map<string, StrategyLabVariantSummary[]>();
  for (const summary of summaries) {
    const group = byLabel.get(summary.label) ?? [];
    group.push(summary);
    byLabel.set(summary.label, group);
  }

  return Array.from(byLabel.values()).map((group) => {
    const first = group[0]!;
    const completed = group.reduce((acc, s) => acc + s.completed, 0);
    const wins = group.reduce((acc, s) => acc + s.wins, 0);
    const losses = group.reduce((acc, s) => acc + s.losses, 0);
    const runs = group.reduce((acc, s) => acc + s.runs, 0);
    const totalPnl = group.reduce((acc, s) => acc + s.totalPnl, 0);
    const tradeCount = group.reduce((acc, s) => acc + s.tradeCount, 0);
    const eligibleFillCount = group.reduce((acc, s) => acc + s.conservativeFill.eligibleFillCount, 0);
    const evaluatedFillCount = group.reduce((acc, s) => acc + s.conservativeFill.evaluatedFillCount, 0);
    const usableEvidenceCount = group.reduce((acc, s) => acc + s.conservativeFill.usableEvidenceCount, 0);
    const bestPnls = group.flatMap((s) => typeof s.bestPnl === "number" ? [s.bestPnl] : []);
    const worstPnls = group.flatMap((s) => typeof s.worstPnl === "number" ? [s.worstPnl] : []);

    return {
      ...first,
      runs,
      completed,
      failed: group.reduce((acc, s) => acc + s.failed, 0),
      canceled: group.reduce((acc, s) => acc + s.canceled, 0),
      wins,
      losses,
      noTrades: group.reduce((acc, s) => acc + s.noTrades, 0),
      blockedVerdicts: group.reduce((acc, s) => acc + s.blockedVerdicts, 0),
      tradeCount,
      winRate: wins + losses > 0 ? wins / (wins + losses) : null,
      tradeRate: completed > 0 ? tradeCount / completed : null,
      totalPnl,
      avgPnl: completed > 0 ? totalPnl / completed : null,
      bestPnl: bestPnls.length > 0 ? Math.max(...bestPnls) : null,
      worstPnl: worstPnls.length > 0 ? Math.min(...worstPnls) : null,
      blocked: group.reduce((acc, s) => acc + s.blocked, 0),
      problems: group.reduce((acc, s) => acc + s.problems, 0),
      brierScore: avgNullable(group.map((s) => s.brierScore)),
      logLoss: avgNullable(group.map((s) => s.logLoss)),
      avgFillRate: avgNullable(group.map((s) => s.avgFillRate)),
      avgCancelRate: avgNullable(group.map((s) => s.avgCancelRate)),
      avgMarkout1s: avgNullable(group.map((s) => s.avgMarkout1s)),
      avgMarkout5s: avgNullable(group.map((s) => s.avgMarkout5s)),
      avgMarkout30s: avgNullable(group.map((s) => s.avgMarkout30s)),
      avgSettlementMarkout: avgNullable(group.map((s) => s.avgSettlementMarkout)),
      markoutSampleCount: group.reduce((acc, s) => acc + s.markoutSampleCount, 0),
      markoutUnavailableCount: group.reduce((acc, s) => acc + s.markoutUnavailableCount, 0),
      avgTurnover: avgNullable(group.map((s) => s.avgTurnover)),
      conservativeFill: {
        noFillCount: group.reduce((acc, s) => acc + s.conservativeFill.noFillCount, 0),
        touchOnlyCount: group.reduce((acc, s) => acc + s.conservativeFill.touchOnlyCount, 0),
        probableFillCount: group.reduce((acc, s) => acc + s.conservativeFill.probableFillCount, 0),
        tradeThroughFillCount: group.reduce((acc, s) => acc + s.conservativeFill.tradeThroughFillCount, 0),
        unknownInsufficientDataCount: group.reduce((acc, s) => acc + s.conservativeFill.unknownInsufficientDataCount, 0),
        usableEvidenceRate: evaluatedFillCount > 0 ? usableEvidenceCount / evaluatedFillCount : null,
        usableEvidenceCount,
        evaluatedFillCount,
        eligibleFillCount,
        avgMarkout1s: avgNullable(group.map((s) => s.conservativeFill.avgMarkout1s)),
        avgMarkout5s: avgNullable(group.map((s) => s.conservativeFill.avgMarkout5s)),
        avgMarkout30s: avgNullable(group.map((s) => s.conservativeFill.avgMarkout30s)),
        adverseSelectionRate: avgNullable(group.map((s) => s.conservativeFill.adverseSelectionRate)),
      },
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  let pairsDir = "data/pairs";
  let variants = ["late-entry", "late-entry-flow-aware", "fair-value-maker"];
  let timeoutMs = 120000;
  let allowPartial = false;

  let outJson = "";
  let outCalibrationJsonl = "";
  const directPairs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pairs") pairsDir = args[++i] || pairsDir;
    else if (args[i] === "--pairs-dir") pairsDir = args[++i] || pairsDir;
    else if (args[i] === "--pair") directPairs.push(args[++i] || "");
    else if (args[i] === "--timeout-ms") timeoutMs = parseInt(args[++i] || String(timeoutMs), 10);
    else if (args[i] === "--allow-partial") allowPartial = true;
    else if (args[i] === "--out-json") outJson = args[++i] || outJson;
    else if (args[i] === "--out-calibration-jsonl") outCalibrationJsonl = args[++i] || outCalibrationJsonl;
    else if (args[i] === "--variants") {
      variants = [];
      while (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
        variants.push(args[++i] as string);
      }
    }
  }

  if (!existsSync(pairsDir)) {
    console.error(`Pairs directory not found: ${pairsDir}`);
    process.exit(1);
  }

  const validManifests: PairManifest[] = [];
  const allManifests = new Map<string, PairManifest>();
  let validCount = 0;
  let invalidCount = 0;

  if (existsSync(pairsDir)) {
    const files = readdirSync(pairsDir).filter(f => f.endsWith(".pair.json"));
    for (const file of files) {
      try {
        const content = readFileSync(path.join(pairsDir, file), "utf-8");
        const manifest = JSON.parse(content) as PairManifest;
        allManifests.set(manifest.slug, manifest);
        if (manifest.pairValidity === "valid") {
          validManifests.push(manifest);
          validCount++;
        } else {
          invalidCount++;
        }
      } catch (e) {
        console.error(`Failed to read/parse ${file}:`, e);
      }
    }
  }

  for (const p of directPairs) {
    if (!p) continue;
    try {
      const content = readFileSync(p, "utf-8");
      const manifest = JSON.parse(content) as PairManifest;
      allManifests.set(manifest.slug, manifest);
      if (manifest.pairValidity === "valid" && !validManifests.some(m => m.slug === manifest.slug)) {
        validManifests.push(manifest);
        validCount++;
      } else if (manifest.pairValidity !== "valid") {
        invalidCount++;
      }
    } catch (e) {
      console.error(`Failed to read/parse pair ${p}:`, e);
    }
  }

  if (validManifests.length === 0) {
    console.log("No valid paired manifests found to run.");
    process.exit(0);
  }

  const replayFiles = validManifests.map(m => m.replayLogPath);
  const l2Files = Object.fromEntries(validManifests.map(m => [m.replayLogPath, m.rawL2LogPath]));

  console.log(`Running Strategy Lab on ${validManifests.length} valid pairs for variants: ${variants.join(", ")}`);
  
  const manager = new StrategyLabBatchManager();
  const maxFilesPerBatch = Math.max(1, Math.floor(MAX_BATCH_RUNS / variants.length));
  const fileChunks = chunk(replayFiles, maxFilesPerBatch);
  const batches: StrategyLabBatch[] = [];
  let finalExitCode = 0;
  let finalStatus = "completed";
  let timedOut = false;
  let internalMismatch = false;

  for (let i = 0; i < fileChunks.length; i++) {
    const files = fileChunks[i]!;
    const batchL2Files = Object.fromEntries(files.map((file) => [file, l2Files[file]!]));
    console.log(`\n[Strategy Lab] Starting batch ${i + 1} / ${fileChunks.length} (${files.length * variants.length} runs)`);

    let batch = await manager.createBatch({
      variants,
      files,
      l2Files: batchL2Files,
    });

    const startMs = Date.now();
    let batchTimedOut = false;
    let batchInternalMismatch = false;

    while (batch.state === "queued" || batch.state === "running") {
      if (shouldTimeout(startMs, timeoutMs)) {
        batchTimedOut = true;
        if (batch.progress.completedRuns === batch.progress.totalRuns && batch.progress.totalRuns > 0 && batch.state === "running") {
          batchInternalMismatch = true;
        }
        manager.cancelBatch(batch.id);
        batch = manager.getBatch(batch.id) ?? batch;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
      batch = manager.getBatch(batch.id) ?? batch;
      process.stdout.write(`\r[Strategy Lab] batch ${i + 1}: ${batch.progress.completedRuns} / ${batch.progress.totalRuns} runs completed...`);
    }

    batches.push(batch);

    if (batchTimedOut) {
      timedOut = true;
      if (batchInternalMismatch) {
        internalMismatch = true;
        console.log(`\n\n[ERROR] Strategy Lab Batch internal state mismatch! Completed ${batch.progress.totalRuns} runs but hung in running state.`);
        finalStatus = "internal_state_mismatch";
        finalExitCode = 1;
      } else {
        console.log(`\n\n[ERROR] Strategy Lab Batch Timed Out!`);
        console.log(`Completed runs: ${batch.progress.completedRuns} / ${batch.progress.totalRuns}`);
        console.log(`Status: timed_out`);
        finalStatus = "timed_out";
        if (!allowPartial) finalExitCode = 1;
      }
      if (!allowPartial) break;
    } else {
      console.log(`\n\nStrategy Lab Batch ${i + 1} Completed. State: ${batch.state}`);
      if (batch.state === "failed") {
        finalStatus = "failed";
        finalExitCode = 1;
        if (!allowPartial) break;
      }
    }
  }

  if (!timedOut && !internalMismatch) {
    console.log(`\n\nStrategy Lab Batch Completed. State: ${finalStatus}`);
  }

  const allRuns = batches.flatMap((batch) => batch.runs);
  const byStrategy = combineVariantSummaries(batches.flatMap((batch) => batch.summary.byStrategy));
  const totalRuns = batches.reduce((acc, batch) => acc + batch.summary.totalRuns, 0);
  const completedRuns = batches.reduce((acc, batch) => acc + batch.summary.completed, 0);
  const failedRuns = batches.reduce((acc, batch) => acc + batch.summary.failed, 0);
  const canceledRuns = batches.reduce((acc, batch) => acc + batch.summary.canceled, 0);
  const totalPnl = batches.reduce((acc, batch) => acc + batch.summary.totalPnl, 0);
  const wins = allRuns.filter((run) => run.verdict === "win").length;
  const losses = allRuns.filter((run) => run.verdict === "loss").length;
  const runPnls = allRuns.flatMap((run) => typeof run.pnl === "number" ? [run.pnl] : []);
  const combinedBatch = {
    ...batches[0]!,
    id: "combined",
    state: finalStatus === "completed" ? "completed" : "failed",
    progress: { totalRuns, completedRuns },
    runs: allRuns,
    summary: {
      totalRuns,
      completed: completedRuns,
      failed: failedRuns,
      canceled: canceledRuns,
      winRate: wins + losses > 0 ? wins / (wins + losses) : null,
      totalPnl,
      avgPnl: completedRuns > 0 ? totalPnl / completedRuns : null,
      bestPnl: runPnls.length > 0 ? Math.max(...runPnls) : null,
      worstPnl: runPnls.length > 0 ? Math.min(...runPnls) : null,
      blocked: allRuns.reduce((acc, run) => acc + run.counts.blocked, 0),
      problems: allRuns.reduce((acc, run) => acc + run.counts.problems, 0),
      byStrategy,
      recommendation: null,
    },
  } as StrategyLabBatch;
  
  console.log(`\n--- Corpus Summary ---`);
  console.log(`Loaded ${allManifests.size} total pair manifests.`);
  console.log(`Valid Pairs: ${validCount}`);
  console.log(`Invalid Pairs: ${invalidCount}`);

  console.log(`\n--- Aggregate Summary ---`);
  console.log(`Total Runs: ${combinedBatch.summary.totalRuns}`);
  console.log(`Total PnL: $${combinedBatch.summary.totalPnl}`);
  console.log(`Win Rate: ${combinedBatch.summary.winRate ? (combinedBatch.summary.winRate * 100).toFixed(1) + "%" : "N/A"}`);

  console.log(`\n--- Fill Evidence Summary ---`);
  for (const vSummary of combinedBatch.summary.byStrategy) {
    console.log(`\nVariant: ${vSummary.label}`);
    console.log(`  PnL: $${vSummary.totalPnl}`);
    console.log(`  Trades: ${vSummary.tradeCount}`);
    console.log(`  Conservative Fill Evidence:`);
    console.log(`    Usable Fills: ${vSummary.conservativeFill.usableEvidenceCount} / ${vSummary.conservativeFill.evaluatedFillCount}`);
    console.log(`    No Fill: ${vSummary.conservativeFill.noFillCount}`);
    console.log(`    Insufficient Data: ${vSummary.conservativeFill.unknownInsufficientDataCount}`);
    console.log(`    Markout 5s Avg: ${vSummary.conservativeFill.avgMarkout5s ?? "N/A"}`);
    console.log(`    Adverse Selection Rate: ${vSummary.conservativeFill.adverseSelectionRate ? (vSummary.conservativeFill.adverseSelectionRate * 100).toFixed(1) + "%" : "N/A"}`);
  }

  if (outCalibrationJsonl) {
    const records = extractCalibrationRecords(combinedBatch, allManifests);
    if (records.length > 0) {
      mkdirSync(path.dirname(outCalibrationJsonl), { recursive: true });
      const jsonl = records.map(r => JSON.stringify(r)).join("\n");
      writeFileSync(outCalibrationJsonl, jsonl, "utf-8");
      console.log(`\nCalibration records written to: ${outCalibrationJsonl} (${records.length} records)`);
    } else {
      console.log(`\nNo calibration records extracted to write.`);
    }
  }

  if (outJson) {
    const records = outCalibrationJsonl ? extractCalibrationRecords(combinedBatch, allManifests) : [];
    mkdirSync(path.dirname(outJson), { recursive: true });
    writeFileSync(outJson, JSON.stringify({
      status: finalStatus,
      totalRuns: combinedBatch.summary.totalRuns,
      completedRuns: combinedBatch.summary.completed,
      failedRuns: combinedBatch.summary.failed,
      canceledRuns: combinedBatch.summary.canceled,
      validPairs: validCount,
      invalidPairs: invalidCount,
      calibrationRecordCount: records.length,
      timedOut: timedOut,
      internalMismatch,
      usedForcedCompletion: false,
      summary: combinedBatch.summary
    }, null, 2), "utf-8");
    console.log(`\nSummary JSON written to: ${outJson}`);
  }

  process.exit(finalExitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
