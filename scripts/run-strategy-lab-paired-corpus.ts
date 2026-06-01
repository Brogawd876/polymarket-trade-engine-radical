import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import * as path from "path";
import { type PairManifest } from "../engine/replay/pair-manifest.ts";
import { StrategyLabBatchManager, type StrategyLabBatch, type StrategyLabVariantSummary, type StrategyLabRunResult, summarizeByStrategy } from "../engine/strategy-lab.ts";
import { resolveStrategySelection } from "../engine/strategy/index.ts";
import { extractCalibrationRecords } from "../engine/replay/calibration-extractor.ts";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { validateReplayFixture } from "../engine/server/helpers/replay-fixtures.ts";

import { shouldTimeout } from "./paired-corpus-utils.ts";

const MAX_BATCH_RUNS = 1500;

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
    const conservativeAdjustedTotalPnl = group.reduce((acc, s) => acc + s.conservativeAdjustedTotalPnl, 0);
    const tradeCount = group.reduce((acc, s) => acc + s.tradeCount, 0);
    const eligibleFillCount = group.reduce((acc, s) => acc + s.conservativeFill.eligibleFillCount, 0);
    const evaluatedFillCount = group.reduce((acc, s) => acc + s.conservativeFill.evaluatedFillCount, 0);
    const usableEvidenceCount = group.reduce((acc, s) => acc + s.conservativeFill.usableEvidenceCount, 0);
    const confirmedFillCount = group.reduce((acc, s) => acc + s.conservativeFill.confirmedFillCount, 0);
    const rejectedFillCount = group.reduce((acc, s) => acc + s.conservativeFill.rejectedFillCount, 0);
    const bestPnls = group.flatMap((s) => typeof s.bestPnl === "number" ? [s.bestPnl] : []);
    const worstPnls = group.flatMap((s) => typeof s.worstPnl === "number" ? [s.worstPnl] : []);
    const conservativeAdjustedBestPnls = group.flatMap((s) =>
      typeof s.conservativeAdjustedBestPnl === "number" ? [s.conservativeAdjustedBestPnl] : [],
    );
    const conservativeAdjustedWorstPnls = group.flatMap((s) =>
      typeof s.conservativeAdjustedWorstPnl === "number" ? [s.conservativeAdjustedWorstPnl] : [],
    );

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
      conservativeAdjustedTotalPnl,
      conservativeAdjustedAvgPnl: completed > 0 ? conservativeAdjustedTotalPnl / completed : null,
      conservativeAdjustedBestPnl: conservativeAdjustedBestPnls.length > 0 ? Math.max(...conservativeAdjustedBestPnls) : null,
      conservativeAdjustedWorstPnl: conservativeAdjustedWorstPnls.length > 0 ? Math.min(...conservativeAdjustedWorstPnls) : null,
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
        confirmedFillCount,
        rejectedFillCount,
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

  // Phase 5C checkpoint & retry flags
  let checkpointJsonl = "";
  let completenessJson = "";
  let retryMode = false;
  let forceMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pairs") pairsDir = args[++i] || pairsDir;
    else if (args[i] === "--pairs-dir") pairsDir = args[++i] || pairsDir;
    else if (args[i] === "--pair") directPairs.push(args[++i] || "");
    else if (args[i] === "--timeout-ms") timeoutMs = parseInt(args[++i] || String(timeoutMs), 10);
    else if (args[i] === "--allow-partial") allowPartial = true;
    else if (args[i] === "--out-json") outJson = args[++i] || outJson;
    else if (args[i] === "--out-calibration-jsonl") outCalibrationJsonl = args[++i] || outCalibrationJsonl;
    else if (args[i] === "--checkpoint-jsonl") checkpointJsonl = args[++i] || checkpointJsonl;
    else if (args[i] === "--completeness-json") completenessJson = args[++i] || completenessJson;
    else if (args[i] === "--retry") retryMode = true;
    else if (args[i] === "--force") forceMode = true;
    else if (args[i] === "--variants") {
      variants = [];
      while (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
        variants.push(args[++i] as string);
      }
    }
  }

  // Preserve and archive the old corrupted report if it exists in the root directory
  const oldReportPath = "fvm-lineage-report.json";
  const archiveDir = "AI_WORKSPACE/archive";
  const archivePath = path.join(archiveDir, "fvm-lineage-report.corrupted-or-partial.json");
  if (existsSync(oldReportPath)) {
    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true });
    }
    if (!existsSync(archivePath)) {
      try {
        const oldContent = readFileSync(oldReportPath, "utf-8");
        writeFileSync(archivePath, oldContent, "utf-8");
        console.log(`\n[Archive] Archived old corrupted lineage report to ${archivePath}`);
      } catch (err) {
        console.error("Failed to archive old report:", err);
      }
    }
  }

  if (!existsSync(pairsDir) && directPairs.length === 0) {
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
          // Verify that the replay fixture is valid and replayable
          const meta = await validateReplayFixture(manifest.replayLogPath);
          if (meta.replayable) {
            validManifests.push(manifest);
            validCount++;
          } else {
            console.log(`[Validation] Skipping non-replayable fixture in ${manifest.slug}: ${meta.reason}`);
            invalidCount++;
          }
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
        const meta = await validateReplayFixture(manifest.replayLogPath);
        if (meta.replayable) {
          validManifests.push(manifest);
          validCount++;
        } else {
          console.log(`[Validation] Skipping non-replayable direct fixture in ${manifest.slug}: ${meta.reason}`);
          invalidCount++;
        }
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

  // gitCommit provider
  function getGitCommit(): string {
    try {
      return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    } catch {
      return "local";
    }
  }

  const currentCommit = getGitCommit();
  const variantConfigHashes: Record<string, string> = {};
  for (const v of variants) {
    try {
      const resolved = resolveStrategySelection(v);
      const config = resolved.config;
      const sortedStr = JSON.stringify(config, Object.keys(config).sort());
      const hash = createHash("sha256").update(sortedStr).digest("hex").slice(0, 16);
      variantConfigHashes[v] = hash;
    } catch (e) {
      variantConfigHashes[v] = "unknown";
    }
  }

  // Load existing checkpoints and perform safety matching check
  const existingMap = new Map<string, any>();
  let skippedOnResume = 0;
  let stalledFailedClassified = 0;

  if (checkpointJsonl && existsSync(checkpointJsonl)) {
    console.log(`Loading existing checkpoint from ${checkpointJsonl}...`);
    const content = readFileSync(checkpointJsonl, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const key = `${row.variant}-${row.pairId}`;

      if (!forceMode) {
        if (row.gitCommit !== currentCommit) {
          throw new Error(`Git commit mismatch in checkpoint row for ${key}: expected ${currentCommit}, found ${row.gitCommit}. Use --force to override.`);
        }
        if (row.allowInferredFlow !== false) {
          throw new Error(`allowInferredFlow mismatch in checkpoint row for ${key}: expected false, found ${row.allowInferredFlow}. Use --force to override.`);
        }
        if (row.fillModel !== "conservative") {
          throw new Error(`fillModel mismatch in checkpoint row for ${key}: expected conservative, found ${row.fillModel}. Use --force to override.`);
        }
        const expectedHash = variantConfigHashes[row.variant];
        if (expectedHash && row.strategyConfigHash !== expectedHash) {
          throw new Error(`Config hash mismatch for variant ${row.variant} in checkpoint row: expected ${expectedHash}, found ${row.strategyConfigHash}. Use --force to override.`);
        }
      }
      existingMap.set(key, row);
    }
    console.log(`Loaded ${existingMap.size} existing rows from checkpoint.`);
  }

  // checker callback for batch run
  const shouldSkipRun = (variant: string, file: string): boolean => {
    const match = file.match(/-([a-f0-9]{32})\.log$/);
    const slug = match ? match[1]! : "";
    const manifest = validManifests.find(m => m.replayLogPath === file);
    const pairId = manifest ? manifest.slug : slug;

    const key = `${variant}-${pairId}`;
    const row = existingMap.get(key);
    if (!row) {
      return false;
    }

    if (row.status === "completed") {
      skippedOnResume++;
      return true;
    }

    if (row.status === "stalled" || row.status === "failed") {
      if (retryMode) {
        stalledFailedClassified++;
        return false; // rerun
      } else {
        skippedOnResume++;
        return true; // skip
      }
    }

    return false;
  };

  const onRunComplete = (run: StrategyLabRunResult) => {
    if (!checkpointJsonl) return;

    const manifest = validManifests.find(m => m.replayLogPath === run.file);
    const pairId = manifest ? manifest.slug : (run.slug || "unknown");
    const key = `${run.strategy}-${pairId}`;
    const previousAttempt = existingMap.get(key);

    const retryCount = previousAttempt ? (previousAttempt.retryCount || 0) + 1 : 0;
    const previousStatus = previousAttempt ? previousAttempt.status : undefined;

    const status = run.status === "completed" ? "completed" : (run.error === "Replay stalled" ? "stalled" : "failed");
    const errorType = status === "stalled" ? "STALL" : (status === "failed" ? "FAILURE" : undefined);

    const row = {
      gitCommit: currentCommit,
      variant: run.strategy,
      pairId,
      replayFile: run.file,
      strategyConfigHash: variantConfigHashes[run.strategy] || "unknown",
      allowInferredFlow: false,
      fillModel: "conservative",
      startedAt: run.startedAt || new Date().toISOString(),
      finishedAt: run.finishedAt || new Date().toISOString(),
      status,
      errorType,
      errorMessage: run.error,
      retryCount,
      previousStatus,
      metrics: run,
    };

    try {
      const parentDir = path.dirname(checkpointJsonl);
      if (parentDir && parentDir !== "." && !existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      appendFileSync(checkpointJsonl, JSON.stringify(row) + "\n", "utf-8");
    } catch (err) {
      console.error("Failed to append checkpoint row:", err);
    }
  };

  console.log(`Running Strategy Lab on ${validManifests.length} valid pairs for variants: ${variants.join(", ")}`);
  
  const manager = new StrategyLabBatchManager();
  const maxFilesPerBatch = Math.max(1, Math.floor(MAX_BATCH_RUNS / variants.length));
  const fileChunks = chunk(replayFiles, maxFilesPerBatch);
  const batches: StrategyLabBatch[] = [];
  let finalExitCode = 0;
  let finalStatus = "completed";

  for (let i = 0; i < fileChunks.length; i++) {
    const files = fileChunks[i]!;
    const batchL2Files = Object.fromEntries(files.map((file) => [file, l2Files[file]!]));
    console.log(`\n[Strategy Lab] Starting batch ${i + 1} / ${fileChunks.length} (${files.length * variants.length} runs)`);

    let batch = await manager.createBatch({
      variants,
      files,
      l2Files: batchL2Files,
      quiet: true,
      onRunComplete,
      shouldSkipRun,
    });

    const startMs = Date.now();
    let lastCompletedCount = 0;
    let lastProgressTimeMs = Date.now();
    let lastHeartbeatTimeMs = Date.now();

    while (batch.state === "queued" || batch.state === "running") {
      await new Promise(r => setTimeout(r, 1000));
      batch = manager.getBatch(batch.id) ?? batch;

      const now = Date.now();

      if (batch.progress.completedRuns > lastCompletedCount) {
        lastCompletedCount = batch.progress.completedRuns;
        lastProgressTimeMs = now;
      }

      // 15 minutes soft watchdog progress warning
      if (now - lastProgressTimeMs > 15 * 60 * 1000) {
        console.warn(`\n[Watchdog] Warning: Batch appears to be stuck. No progress for 15m.`);
        lastProgressTimeMs = now;
      }

      // Heartbeat logging every minute
      if (now - lastHeartbeatTimeMs >= 60 * 1000) {
        lastHeartbeatTimeMs = now;
        const elapsedSec = Math.floor((now - startMs) / 1000);
        const elapsedStr = `${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s`;

        let estRemainingStr = "estimating...";
        if (batch.progress.completedRuns > 0) {
          const secPerRun = elapsedSec / batch.progress.completedRuns;
          const remainingRuns = batch.progress.totalRuns - batch.progress.completedRuns;
          const remainingSec = Math.floor(secPerRun * remainingRuns);
          estRemainingStr = `${Math.floor(remainingSec / 60)}m${remainingSec % 60}s`;
        }

        const runningRun = batch.runs.find(r => r.status === "running");
        const runningEnv = runningRun ? runningRun.slug : "idle";
        const runningVariant = runningRun ? runningRun.strategy : "idle";

        console.log(`\n[Strategy Lab] batch ${i + 1}: ${batch.progress.completedRuns} / ${batch.progress.totalRuns} runs completed... variants: ${runningVariant}, env: ${runningEnv}... elapsed: ${elapsedStr}, est. remaining: ${estRemainingStr}`);
      }

      process.stdout.write(`\r[Strategy Lab] batch ${i + 1}: ${batch.progress.completedRuns} / ${batch.progress.totalRuns} runs completed...`);
    }

    batches.push(batch);

    console.log(`\n\nStrategy Lab Batch ${i + 1} Completed. State: ${batch.state}`);
    if (batch.state === "failed") {
      finalStatus = "failed";
      finalExitCode = 1;
      if (!allowPartial) break;
    }
  }

  // Aggregate results solely from checkpoint file
  let finalRuns: StrategyLabRunResult[] = [];
  if (checkpointJsonl && existsSync(checkpointJsonl)) {
    console.log(`\nReconstructing aggregate results from checkpoint rows...`);
    const content = readFileSync(checkpointJsonl, "utf-8");
    const lines = content.split("\n");
    const latestRows = new Map<string, any>();
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      latestRows.set(`${row.variant}-${row.pairId}`, row);
    }

    for (const row of latestRows.values()) {
      if (row.metrics) {
        const runResult = row.metrics as StrategyLabRunResult;
        runResult.status = row.status === "completed" ? "completed" : "failed";
        runResult.error = row.errorMessage;
        finalRuns.push(runResult);
      }
    }
    console.log(`Reconstructed ${finalRuns.length} total runs from checkpoint file.`);
  } else {
    finalRuns = batches.flatMap((batch) => batch.runs);
  }

  const byStrategy = summarizeByStrategy(finalRuns);
  const totalRuns = finalRuns.length;
  const completedRuns = finalRuns.filter(r => r.status === "completed").length;
  const failedRuns = finalRuns.filter(r => r.status === "failed").length;
  const canceledRuns = finalRuns.filter(r => r.status === "canceled").length;
  const totalPnl = finalRuns.reduce((acc, r) => acc + (r.pnl || 0), 0);
  const wins = finalRuns.filter((run) => run.verdict === "win").length;
  const losses = finalRuns.filter((run) => run.verdict === "loss").length;

  const combinedBatch = {
    id: "combined",
    state: finalStatus === "completed" ? "completed" : "failed",
    progress: { totalRuns, completedRuns },
    runs: finalRuns,
    summary: {
      totalRuns,
      completed: completedRuns,
      failed: failedRuns,
      canceled: canceledRuns,
      winRate: wins + losses > 0 ? wins / (wins + losses) : null,
      totalPnl,
      avgPnl: completedRuns > 0 ? totalPnl / completedRuns : null,
      bestPnl: finalRuns.flatMap(r => typeof r.pnl === "number" ? [r.pnl] : []).length > 0 ? Math.max(...finalRuns.flatMap(r => typeof r.pnl === "number" ? [r.pnl] : [])) : null,
      worstPnl: finalRuns.flatMap(r => typeof r.pnl === "number" ? [r.pnl] : []).length > 0 ? Math.min(...finalRuns.flatMap(r => typeof r.pnl === "number" ? [r.pnl] : [])) : null,
      blocked: finalRuns.reduce((acc, run) => acc + run.counts.blocked, 0),
      problems: finalRuns.reduce((acc, run) => acc + run.counts.problems, 0),
      byStrategy,
      recommendation: null,
    },
  } as any;

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
    console.log(`  Missing Metrics (Honest Reporting):`);
    console.log(`    drawdown: not exported by StrategyLabVariantSummary; likely requires extension in engine/strategy-lab.ts`);
    console.log(`    capitalUtilization: not exported by StrategyLabVariantSummary; likely requires extension in engine/strategy-lab.ts`);
    console.log(`    settlementPnL: not exported by StrategyLabVariantSummary; likely requires extension in engine/strategy-lab.ts`);
    console.log(`    missedFills: not exported by StrategyLabVariantSummary; likely requires extension in engine/strategy-lab.ts`);
    console.log(`    goodBlocks: not exported by StrategyLabVariantSummary; likely requires extension in engine/strategy-lab.ts`);
  }

  // Champion assessment honesty
  console.log(`\n--- Champion Assessment ---`);
  const totalPlannedCount = variants.length * validManifests.length;
  if (finalRuns.length < totalPlannedCount) {
    console.log(`Outcome: inconclusive, runner/replay export still needs repair (Completed ${finalRuns.length} of ${totalPlannedCount} planned runs).`);
  } else {
    const winner = byStrategy[0];
    if (winner) {
      console.log(`Declared Champion: ${winner.label} (${winner.strategy}) with score ${winner.score.toFixed(2)}`);
    } else {
      console.log(`Outcome: no viable variants evaluated.`);
    }
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
    const outDir = path.dirname(outJson);
    if (outDir && outDir !== "." && !existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    // Aggregated only from checkpoint rows
    writeFileSync(outJson, JSON.stringify({
      status: finalStatus,
      totalRuns: combinedBatch.summary.totalRuns,
      completedRuns: combinedBatch.summary.completed,
      failedRuns: combinedBatch.summary.failed,
      canceledRuns: combinedBatch.summary.canceled,
      validPairs: validCount,
      invalidPairs: invalidCount,
      calibrationRecordCount: records.length,
      usedForcedCompletion: false,
      summary: combinedBatch.summary
    }, null, 2), "utf-8");
    console.log(`\nSummary JSON written to: ${outJson}`);
  }

  // Write completeness report
  if (completenessJson) {
    console.log(`Writing completeness report to ${completenessJson}...`);
    
    const plannedCount = variants.length * validManifests.length;
    let completed = 0;
    let stalled = 0;
    let failedNonStall = 0;

    const latestCheckpointRows = new Map<string, any>();
    if (checkpointJsonl && existsSync(checkpointJsonl)) {
      const content = readFileSync(checkpointJsonl, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        latestCheckpointRows.set(`${row.variant}-${row.pairId}`, row);
      }
    }

    const variantBreakdown: Record<string, any> = {};
    for (const v of variants) {
      variantBreakdown[v] = { planned: validManifests.length, completed: 0, stalled: 0, failed_nonstall: 0, missing: 0 };
    }

    for (const v of variants) {
      for (const m of validManifests) {
        const key = `${v}-${m.slug}`;
        const row = latestCheckpointRows.get(key);
        if (row) {
          if (row.status === "completed") {
            completed++;
            variantBreakdown[v].completed++;
          } else if (row.status === "stalled") {
            stalled++;
            variantBreakdown[v].stalled++;
          } else {
            failedNonStall++;
            variantBreakdown[v].failed_nonstall++;
          }
        } else {
          variantBreakdown[v].missing++;
        }
      }
    }

    const missing = plannedCount - (completed + stalled + failedNonStall);

    writeFileSync(completenessJson, JSON.stringify({
      planned: plannedCount,
      completed,
      stalled,
      failed_nonstall: failedNonStall,
      missing,
      output_file: outJson,
      variants: variantBreakdown
    }, null, 2), "utf-8");
    console.log(`Completeness JSON written to: ${completenessJson}`);
  }

  console.log(`\nCheckpointing Stats:`);
  console.log(`  Rows skipped on resume: ${skippedOnResume}`);
  console.log(`  Stalled/failed rows classified & retried: ${stalledFailedClassified}`);

  process.exit(finalExitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
