/**
 * Streaming Calibration Pipeline
 *
 * Memory-efficient alternative to run-strategy-lab-paired-corpus.ts
 * for large corpus calibration runs.
 *
 * Key design decisions:
 * - Processes ONE variant per invocation (run multiple times for multiple variants)
 * - Batch size of 6 keeps peak memory low (~50MB vs 500MB+)
 * - onRunComplete callback extracts calibration records immediately per-run
 * - Evidence arrays stripped after extraction (memory freed)
 * - Progress file enables resume on crash
 * - JSONL output is append-only (safe across restarts)
 *
 * Usage:
 *   bun scripts/run-lean-calibration.ts --variant fvm-v1.5.0-avellaneda
 *   bun scripts/run-lean-calibration.ts --variant fvm-v5.0.0-avellaneda-calibrated
 *   bun scripts/run-lean-calibration.ts --variant fvm-v1.1.1-turbo
 *
 * Options:
 *   --variant <name>       Strategy variant to calibrate (required)
 *   --pairs-dir <path>     Directory with pair manifests (default: data/pairs)
 *   --out-dir <path>       Output directory (default: data/calibration-output)
 *   --batch-size <n>       Files per batch (default: 6)
 *   --timeout-ms <n>       Timeout per batch in ms (default: 180000)
 *   --verbose-replay       Print per-run replay/strategy logs
 *   --no-resume            Don't resume from previous progress
 *   --retry-failed         Retry slugs that previously failed or timed out
 *   --allow-partial        Exit 0 when some runs fail but completed evidence exists
 *   --help                 Show this help
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import * as path from "path";
import type { PairManifest } from "../engine/replay/pair-manifest.ts";
import {
  StrategyLabBatchManager,
  type StrategyLabBatch,
  type StrategyLabBatchProgress,
  type StrategyLabRunResult,
  type StrategyLabVariantSummary,
} from "../engine/strategy-lab.ts";
import { extractCalibrationRecords } from "../engine/replay/calibration-extractor.ts";
import { shouldTimeout } from "./paired-corpus-utils.ts";
import { validateReplayFixture } from "../engine/server/helpers/replay-fixtures.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Merge multiple `StrategyLabVariantSummary` arrays (one per batch) into a
 * single deduplicated array keyed by label.
 *
 * Copied from run-strategy-lab-paired-corpus.ts — the logic is
 * self-contained and operates only on summary structs, never on run data.
 */
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

// ---------------------------------------------------------------------------
// Progress persistence (resume support)
// ---------------------------------------------------------------------------

interface ProgressFile {
  variant: string;
  processedSlugs: string[];
  failedSlugs?: string[];
  failedRunErrors?: Record<string, { error: string; updatedAtMs: number }>;
  recordCount: number;
  completedRuns: number;
  failedRuns: number;
  updatedAtMs: number;
}

function emptyProgress(variant: string): ProgressFile {
  return {
    variant,
    processedSlugs: [],
    failedSlugs: [],
    failedRunErrors: {},
    recordCount: 0,
    completedRuns: 0,
    failedRuns: 0,
    updatedAtMs: Date.now(),
  };
}

function loadProgress(filePath: string, variant: string): ProgressFile {
  if (!existsSync(filePath)) {
    return emptyProgress(variant);
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as ProgressFile;
    if (raw.variant !== variant) {
      console.warn(`[warn] Progress file variant mismatch (${raw.variant} vs ${variant}). Starting fresh.`);
      return emptyProgress(variant);
    }
    raw.processedSlugs = Array.isArray(raw.processedSlugs) ? raw.processedSlugs : [];
    raw.failedSlugs = Array.isArray(raw.failedSlugs) ? raw.failedSlugs : [];
    raw.failedRunErrors = raw.failedRunErrors && typeof raw.failedRunErrors === "object" ? raw.failedRunErrors : {};
    return raw;
  } catch {
    return emptyProgress(variant);
  }
}

function saveProgress(filePath: string, progress: ProgressFile): void {
  progress.updatedAtMs = Date.now();
  writeFileSync(filePath, JSON.stringify(progress, null, 2), "utf-8");
}

function progressFromBatch(batch: StrategyLabBatch): StrategyLabBatchProgress {
  return {
    id: batch.id,
    state: batch.state,
    totalRuns: batch.progress.totalRuns,
    completedRuns: batch.progress.completedRuns,
    failedRuns: batch.runs.filter((run) => run.status === "failed").length,
    canceledRuns: batch.runs.filter((run) => run.status === "canceled").length,
    currentSlug: batch.runs.find((run) => run.status === "running")?.slug ?? null,
    updatedAtMs: batch.updatedAtMs,
  };
}

function loadSummaryProgress(filePath: string): StrategyLabVariantSummary[] {
  if (!existsSync(filePath)) return [];
  const summaries: StrategyLabVariantSummary[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { summaries?: StrategyLabVariantSummary[] };
      if (Array.isArray(entry.summaries)) summaries.push(...entry.summaries);
    } catch {
      // Ignore corrupt partial lines; calibration JSONL remains the source of evidence.
    }
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
Streaming Calibration Pipeline

Usage:
  bun scripts/run-lean-calibration.ts --variant <name> [options]

Options:
  --variant <name>       Strategy variant to calibrate (required)
  --pairs-dir <path>     Directory with pair manifests (default: data/pairs)
  --out-dir <path>       Output directory (default: data/calibration-output)
  --batch-size <n>       Files per batch (default: 6)
  --timeout-ms <n>       Timeout per batch in ms (default: 180000)
  --verbose-replay       Print per-run replay/strategy logs
  --no-resume            Don't resume from previous progress
  --retry-failed         Retry slugs that previously failed or timed out
  --allow-partial        Exit 0 when some runs fail but completed evidence exists
  --help                 Show this help
`.trim());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let variant = "";
  let pairsDir = "data/pairs";
  let outDir = "data/calibration-output";
  let batchSize = 6;
  let timeoutMs = 180_000;
  let resume = true;
  let quietReplay = true;
  let retryFailed = false;
  let allowPartial = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--variant") {
      variant = args[++i] || "";
    } else if (arg === "--pairs-dir") {
      pairsDir = args[++i] || pairsDir;
    } else if (arg === "--out-dir") {
      outDir = args[++i] || outDir;
    } else if (arg === "--batch-size") {
      batchSize = parseInt(args[++i] || String(batchSize), 10);
    } else if (arg === "--timeout-ms") {
      timeoutMs = parseInt(args[++i] || String(timeoutMs), 10);
    } else if (arg === "--verbose-replay") {
      quietReplay = false;
    } else if (arg === "--no-resume") {
      resume = false;
    } else if (arg === "--retry-failed") {
      retryFailed = true;
    } else if (arg === "--allow-partial") {
      allowPartial = true;
    }
  }

  if (!variant) {
    console.error("Error: --variant is required. Use --help for usage information.");
    process.exit(1);
  }

  if (!existsSync(pairsDir)) {
    console.error(`Pairs directory not found: ${pairsDir}`);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Load manifests
  // -----------------------------------------------------------------------

  const allManifests = new Map<string, PairManifest>();
  const validManifests: PairManifest[] = [];
  let invalidCount = 0;

  const files = readdirSync(pairsDir).filter((f) => f.endsWith(".pair.json"));
  for (const file of files) {
    try {
      const content = readFileSync(path.join(pairsDir, file), "utf-8");
      const manifest = JSON.parse(content) as PairManifest;
      allManifests.set(manifest.slug, manifest);
      if (manifest.pairValidity === "valid") {
        validManifests.push(manifest);
      } else {
        invalidCount++;
      }
    } catch (e) {
      console.error(`Failed to read/parse ${file}:`, e);
    }
  }

  // Sort by slug for deterministic order (important for resume)
  validManifests.sort((a, b) => a.slug.localeCompare(b.slug));

  if (validManifests.length === 0) {
    console.log("No valid paired manifests found to run.");
    process.exit(0);
  }

  console.log(`[lean-cal] Loaded ${validManifests.length} valid / ${invalidCount} invalid manifests`);
  console.log(`[lean-cal] Variant: ${variant}  |  Batch size: ${batchSize}  |  Timeout: ${timeoutMs}ms`);
  console.log(`[lean-cal] Replay logs: ${quietReplay ? "quiet" : "verbose"}`);

  // -----------------------------------------------------------------------
  // Setup output paths
  // -----------------------------------------------------------------------

  mkdirSync(outDir, { recursive: true });

  const safeVariant = variant.replace(/[^a-zA-Z0-9._-]/g, "_");
  const outJsonlPath = path.join(outDir, `calibration-${safeVariant}.jsonl`);
  const progressPath = path.join(outDir, `progress-${safeVariant}.json`);
  const summaryJsonPath = path.join(outDir, `summary-${safeVariant}.json`);
  const batchSummaryJsonlPath = path.join(outDir, `summary-batches-${safeVariant}.jsonl`);

  // -----------------------------------------------------------------------
  // Resume support
  // -----------------------------------------------------------------------

  let progress = resume
    ? loadProgress(progressPath, variant)
    : emptyProgress(variant);

  const processedSet = new Set(progress.processedSlugs);
  const failedSet = new Set(progress.failedSlugs ?? []);
  const skippedSet = retryFailed ? processedSet : new Set([...processedSet, ...failedSet]);
  let remaining = validManifests.filter((m) => !skippedSet.has(m.slug));
  let preflightFailedRuns = 0;

  if (remaining.length < validManifests.length) {
    const skipped = validManifests.length - remaining.length;
    console.log(`[lean-cal] Resuming: ${skipped} slugs already processed, ${remaining.length} remaining`);
    if (!retryFailed && failedSet.size > 0) {
      console.log(`[lean-cal] Known failed slugs skipped: ${failedSet.size} (use --retry-failed to retry)`);
    }
  }

  if (remaining.length === 0) {
    console.log("[lean-cal] All slugs already processed. Nothing to do.");
    process.exit(0);
  }

  const replayable: PairManifest[] = [];
  let skippedUnresolved = 0;
  for (const manifest of remaining) {
    const fixture = await validateReplayFixture(manifest.replayLogPath);
    if (fixture.replayable) {
      replayable.push(manifest);
      continue;
    }

    if (!failedSet.has(manifest.slug)) {
      failedSet.add(manifest.slug);
      progress.failedSlugs = [...(progress.failedSlugs ?? []), manifest.slug];
      preflightFailedRuns++;
    }
    skippedUnresolved++;
    progress.failedRunErrors = progress.failedRunErrors ?? {};
    progress.failedRunErrors[manifest.slug] = {
      error: fixture.reason ?? "Replay fixture is not replayable",
      updatedAtMs: Date.now(),
    };
  }
  if (skippedUnresolved > 0) {
    console.log(`[lean-cal] Skipped ${skippedUnresolved} unresolved/non-replayable replay fixture(s)`);
    progress.failedRuns += preflightFailedRuns;
    saveProgress(progressPath, progress);
  }
  remaining = replayable;

  if (remaining.length === 0) {
    console.log("[lean-cal] No replayable manifests remain after preflight.");
    process.exit(allowPartial && progress.recordCount > 0 ? 0 : 1);
  }

  // -----------------------------------------------------------------------
  // Process in batches
  // -----------------------------------------------------------------------

  const batches = chunk(remaining, batchSize);
  const allVariantSummaries: StrategyLabVariantSummary[] = resume
    ? loadSummaryProgress(batchSummaryJsonlPath)
    : [];
  if (resume && allVariantSummaries.length === 0 && existsSync(summaryJsonPath)) {
    try {
      const existingSummary = JSON.parse(readFileSync(summaryJsonPath, "utf-8")) as { byStrategy?: StrategyLabVariantSummary[] };
      if (Array.isArray(existingSummary.byStrategy)) allVariantSummaries.push(...existingSummary.byStrategy);
    } catch {
      // The next completed batch will rebuild an append-only summary checkpoint.
    }
  }
  let globalRecordCount = progress.recordCount;
  let globalCompletedRuns = progress.completedRuns;
  let globalFailedRuns = progress.failedRuns;
  let exitCode = preflightFailedRuns > 0 && !allowPartial ? 1 : 0;

  console.log(`[lean-cal] Processing ${remaining.length} manifests in ${batches.length} batches\n`);

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batchManifests = batches[bIdx]!;
    const batchFiles = batchManifests.map((m) => m.replayLogPath);
    const batchL2Files = Object.fromEntries(batchManifests.map((m) => [m.replayLogPath, m.rawL2LogPath]));

    // Build a lookup map for this batch's manifests (keyed by slug)
    const batchManifestMap = new Map<string, PairManifest>();
    for (const m of batchManifests) {
      batchManifestMap.set(m.slug, m);
    }

    let batchRecordCount = 0;

    console.log(`[lean-cal] Batch ${bIdx + 1}/${batches.length} — ${batchFiles.length} files (${batchFiles.length} runs)`);

    // Create a fresh manager per batch so previous batch data is GC-eligible
    const manager = new StrategyLabBatchManager();

    let batch: StrategyLabBatch;
    try {
      batch = await manager.createBatch({
        variants: [variant],
        files: batchFiles,
        l2Files: batchL2Files,
        quiet: quietReplay,
        onRunComplete: (run: StrategyLabRunResult) => {
          // Extract calibration records from this single run immediately
          const miniBatch = {
            runs: [run],
            summary: { byStrategy: [] },
          } as unknown as StrategyLabBatch;
          const records = extractCalibrationRecords(miniBatch, allManifests);
          if (records.length > 0) {
            appendFileSync(outJsonlPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
            batchRecordCount += records.length;
            globalRecordCount += records.length;
          }
        },
      });
    } catch (error) {
      console.error(`[lean-cal] Failed to create batch ${bIdx + 1}:`, error);
      exitCode = 1;
      continue;
    }

    // Poll for completion
    const startMs = Date.now();
    let timedOut = false;
    let progressInfo = progressFromBatch(batch);

    while (progressInfo.state === "queued" || progressInfo.state === "running") {
      if (shouldTimeout(startMs, timeoutMs)) {
        timedOut = true;
        manager.cancelBatch(batch.id);
        progressInfo = manager.getBatchProgress(batch.id) ?? progressInfo;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
      progressInfo = manager.getBatchProgress(batch.id) ?? progressInfo;
      process.stdout.write(
        `\r[lean-cal]   ${progressInfo.completedRuns}/${progressInfo.totalRuns} runs completed...`,
      );
    }

    batch = manager.getBatch(batch.id) ?? batch;

    if (timedOut) {
      console.log(`\n[lean-cal] Batch ${bIdx + 1} timed out (${progressInfo.completedRuns}/${progressInfo.totalRuns} runs)`);
      if (!allowPartial) exitCode = 1;
    } else {
      console.log(`\n[lean-cal] Batch ${bIdx + 1} done — state: ${batch.state}  records: ${batchRecordCount}`);
      if (batch.state === "failed" && !allowPartial) exitCode = 1;
    }

    // Accumulate lightweight summaries
    if (batch.summary.byStrategy.length > 0) {
      appendFileSync(
        batchSummaryJsonlPath,
        JSON.stringify({
          batchIndex: bIdx + 1,
          updatedAtMs: Date.now(),
          summaries: batch.summary.byStrategy,
        }) + "\n",
        "utf-8",
      );
    }
    allVariantSummaries.push(...batch.summary.byStrategy);

    // Count completed/failed
    for (const run of batch.runs) {
      if (run.status === "completed") globalCompletedRuns++;
      else if (run.status === "failed") globalFailedRuns++;
    }

    // Track processed slugs (even timed-out batches may have partial progress)
    for (const run of batch.runs) {
      if (run.status === "completed" && run.slug) {
        if (!processedSet.has(run.slug)) {
          processedSet.add(run.slug);
          progress.processedSlugs.push(run.slug);
        }
        failedSet.delete(run.slug);
        if (progress.failedSlugs) {
          progress.failedSlugs = progress.failedSlugs.filter((slug) => slug !== run.slug);
        }
        if (progress.failedRunErrors) delete progress.failedRunErrors[run.slug];
      } else if ((run.status === "failed" || run.status === "canceled") && run.slug) {
        if (!failedSet.has(run.slug)) {
          failedSet.add(run.slug);
          progress.failedSlugs = [...(progress.failedSlugs ?? []), run.slug];
        }
        progress.failedRunErrors = progress.failedRunErrors ?? {};
        progress.failedRunErrors[run.slug] = {
          error: run.error ?? run.status,
          updatedAtMs: Date.now(),
        };
      }
    }
    progress.recordCount = globalRecordCount;
    progress.completedRuns = globalCompletedRuns;
    progress.failedRuns = globalFailedRuns;
    saveProgress(progressPath, progress);

    // manager and batch go out of scope — GC can reclaim
  }

  // -----------------------------------------------------------------------
  // Final summary
  // -----------------------------------------------------------------------

  const combined = combineVariantSummaries(allVariantSummaries);

  console.log(`\n--- Lean Calibration Summary ---`);
  console.log(`Variant:          ${variant}`);
  console.log(`Completed Runs:   ${globalCompletedRuns}`);
  console.log(`Failed Runs:      ${globalFailedRuns}`);
  console.log(`Failed Slugs:     ${progress.failedSlugs?.length ?? 0}`);
  console.log(`Calibration Recs: ${globalRecordCount}`);
  console.log(`JSONL Output:     ${outJsonlPath}`);

  for (const vs of combined) {
    console.log(`\nVariant: ${vs.label}`);
    console.log(`  PnL: $${vs.totalPnl}`);
    console.log(`  Trades: ${vs.tradeCount}`);
    console.log(`  Conservative Fill Evidence:`);
    console.log(`    Usable Fills: ${vs.conservativeFill.usableEvidenceCount} / ${vs.conservativeFill.evaluatedFillCount}`);
    console.log(`    No Fill: ${vs.conservativeFill.noFillCount}`);
    console.log(`    Insufficient Data: ${vs.conservativeFill.unknownInsufficientDataCount}`);
    console.log(`    Markout 5s Avg: ${vs.conservativeFill.avgMarkout5s ?? "N/A"}`);
    console.log(`    Adverse Selection Rate: ${vs.conservativeFill.adverseSelectionRate ? (vs.conservativeFill.adverseSelectionRate * 100).toFixed(1) + "%" : "N/A"}`);
  }

  // Write summary JSON
  writeFileSync(
    summaryJsonPath,
    JSON.stringify(
      {
        variant,
        completedRuns: globalCompletedRuns,
        failedRuns: globalFailedRuns,
        failedSlugs: progress.failedSlugs ?? [],
        failedRunErrors: progress.failedRunErrors ?? {},
        calibrationRecordCount: globalRecordCount,
        processedSlugs: progress.processedSlugs.length,
        totalValidManifests: validManifests.length,
        byStrategy: combined,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\nSummary JSON written to: ${summaryJsonPath}`);

  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
