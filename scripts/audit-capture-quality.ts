/**
 * audit-capture-quality.ts
 *
 * Phase 8U: Pre-capture data-quality audit gate.
 *
 * Reads pair manifests (*.pair.json) and optional calibration NDJSON records,
 * then produces a JSON report and Markdown summary with a capture_quality_pass |
 * capture_quality_warn | capture_quality_fail verdict.
 *
 * Usage:
 *   bun scripts/audit-capture-quality.ts \
 *     --pairs-dir data/pairs \
 *     [--calibration-jsonl data/calibration.ndjson] \
 *     [--out-json data/reports/capture-quality-audit.json] \
 *     [--out-md   data/reports/capture-quality-audit.md] \
 *     [--min-valid-pairs 1] \
 *     [--dry-run]
 *
 * Strict constraints:
 *   - Does NOT modify any live execution or risk-gate behavior.
 *   - Does NOT commit generated data files.
 *   - Does NOT replace nulls with fake values.
 *   - Null is reported as a missing-data reason, never silently filled.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import type { PairManifest } from "../engine/replay/pair-manifest.ts";
import type { CalibrationRecord } from "../engine/replay/calibration-extractor.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CaptureQualityDecision =
  | "capture_quality_pass"
  | "capture_quality_warn"
  | "capture_quality_fail";

export type PairAuditRow = {
  slug: string;
  pairValidity: string;
  coverageVerdict: string;
  rawL2EventCount: number;
  rawL2TradeEventCount: number;
  rawL2BookEventCount: number;
  replayEventCount: number;
  recorderStopReason: string | undefined;
  recorderCompletedEventSeen: boolean | undefined;
  validationErrorCount: number;
  validationWarningCount: number;
  validationErrors: string[];
  validationWarnings: string[];
  parseErrorCount: number;
};

export type CaptureQualityAuditReport = {
  generatedAtMs: number;
  pairsDir: string;

  // --- Pair summary ---
  totalPairManifests: number;
  validPairCount: number;
  invalidPairCount: number;
  validToInvalidRatio: number | null;
  completeCoverageCount: number;
  incompleteCoverageCount: number;

  // --- Raw event totals ---
  totalRawL2Events: number;
  totalRawL2TradeEvents: number;
  totalRawL2BookEvents: number;
  totalReplayEvents: number;

  // --- Recorder stop reasons ---
  recorderStopReasonCounts: Record<string, number>;

  // --- Chainlink audit ---
  missingChainlinkAnchorPairCount: number;
  staleOrDegradedChainlinkPairCount: number;

  // --- Calibration record stats (if supplied) ---
  totalCalibrationRecords: number;
  missingDecisionFeatureCount: number;
  missingModelProbabilityCount: number;
  missingFairValueEdgeCount: number;
  missingMarkoutCount: number;
  missingChainlinkAnchorRecordCount: number;
  tradePrintBackedCount: number;
  touchOnlyCount: number;
  noFillCount: number;
  missingDecisionFeatureRate: number | null;

  // --- Top invalidity reasons ---
  topInvalidityReasons: { reason: string; count: number }[];
  topMissingDataReasons: { reason: string; count: number }[];

  // --- Temporal spread ---
  temporalSpread: {
    firstSlotMs: number | null;
    lastSlotMs: number | null;
    approxHoursCovered: number;
    uniqueSlugs: number;
  };

  // --- Flags ---
  failReasons: string[];
  warnReasons: string[];

  // --- Verdict ---
  decision: CaptureQualityDecision;

  // --- Raw pair rows for inspection ---
  pairs: PairAuditRow[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseManifest(filePath: string): PairManifest | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as PairManifest;
  } catch {
    return null;
  }
}

function parseCalibrationJsonl(filePath: string): CalibrationRecord[] {
  const records: CalibrationRecord[] = [];
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as CalibrationRecord);
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file not found or unreadable
  }
  return records;
}

function topN(counter: Record<string, number>, n = 10): { reason: string; count: number }[] {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([reason, count]) => ({ reason, count }));
}

// ── Core audit logic ──────────────────────────────────────────────────────────

export function runCaptureQualityAudit(opts: {
  pairsDir: string;
  calibrationJsonlPath?: string;
  minValidPairs?: number;
}): CaptureQualityAuditReport {
  const { pairsDir, calibrationJsonlPath, minValidPairs = 1 } = opts;

  const failReasons: string[] = [];
  const warnReasons: string[] = [];

  // --- Load pair manifests ---
  const pairFiles: string[] = existsSync(pairsDir)
    ? readdirSync(pairsDir)
        .filter((f) => f.endsWith(".pair.json"))
        .map((f) => path.join(pairsDir, f))
    : [];

  const pairs: PairAuditRow[] = [];
  let validPairCount = 0;
  let invalidPairCount = 0;
  let completeCoverageCount = 0;
  let incompleteCoverageCount = 0;
  let totalRawL2Events = 0;
  let totalRawL2TradeEvents = 0;
  let totalRawL2BookEvents = 0;
  let totalReplayEvents = 0;
  let missingChainlinkAnchorPairCount = 0;
  let staleOrDegradedChainlinkPairCount = 0;

  const recorderStopReasonCounts: Record<string, number> = {};
  const invalidityReasonCounter: Record<string, number> = {};

  let firstSlotMs: number | null = null;
  let lastSlotMs: number | null = null;
  const slugsSeen = new Set<string>();

  for (const filePath of pairFiles) {
    const manifest = parseManifest(filePath);

    if (!manifest) {
      invalidPairCount++;
      failReasons.push(`Failed to parse manifest: ${path.basename(filePath)}`);
      invalidityReasonCounter["parse_error"] = (invalidityReasonCounter["parse_error"] ?? 0) + 1;
      pairs.push({
        slug: path.basename(filePath, ".pair.json"),
        pairValidity: "invalid",
        coverageVerdict: "unknown",
        rawL2EventCount: 0,
        rawL2TradeEventCount: 0,
        rawL2BookEventCount: 0,
        replayEventCount: 0,
        recorderStopReason: undefined,
        recorderCompletedEventSeen: undefined,
        validationErrorCount: 1,
        validationWarningCount: 0,
        validationErrors: [`Failed to parse: ${path.basename(filePath)}`],
        validationWarnings: [],
        parseErrorCount: 1,
      });
      continue;
    }

    // Counts
    if (manifest.pairValidity === "valid") {
      validPairCount++;

      // Fail if valid pair has zero raw L2 events
      if (manifest.rawL2EventCount === 0) {
        failReasons.push(`Valid pair ${manifest.slug} has zero raw L2 events`);
      }
      // Fail if valid pair has incomplete coverage
      if (manifest.coverageVerdict !== "complete") {
        failReasons.push(`Valid pair ${manifest.slug} has incomplete coverage: ${manifest.coverageVerdict}`);
        incompleteCoverageCount++;
      } else {
        completeCoverageCount++;
      }
    } else {
      invalidPairCount++;
      incompleteCoverageCount++;
    }

    totalRawL2Events += manifest.rawL2EventCount ?? 0;
    totalRawL2TradeEvents += manifest.rawL2TradeEventCount ?? 0;
    totalRawL2BookEvents += manifest.rawL2BookEventCount ?? 0;
    totalReplayEvents += manifest.replayEventCount ?? 0;

    // Recorder stop reason
    const stopReason = manifest.recorderStopReason ?? "unknown";
    recorderStopReasonCounts[stopReason] = (recorderStopReasonCounts[stopReason] ?? 0) + 1;
    if (stopReason === "unknown" && manifest.pairValidity === "valid") {
      warnReasons.push(`Valid pair ${manifest.slug} has unknown recorder stop reason`);
    }

    // Chainlink anchor check (inferred from validationErrors/warnings or manifest fields)
    // We look at whether the pair has a missing anchor warning in its validation data.
    // The pair-validator doesn't currently write a chainlink_anchor_missing field, so
    // we infer from: if the pair is valid and has zero slotStartMs (proxy for missing anchor info)
    // We check validationWarnings for the keyword as a heuristic. A future improvement would
    // be to add an explicit chainlinkAnchorMissing: boolean field to PairManifest.
    const hasChainlinkWarning = manifest.validationWarnings?.some(
      (w) => w.includes("chainlink") || w.includes("anchor")
    ) || manifest.validationErrors?.some(
      (e) => e.includes("chainlink") || e.includes("anchor")
    );
    if (hasChainlinkWarning) {
      missingChainlinkAnchorPairCount++;
      if (manifest.pairValidity === "valid") {
        failReasons.push(
          `Valid pair ${manifest.slug} has a Chainlink anchor issue: check validationErrors/Warnings`
        );
      }
    }

    // Invalidity reasons
    for (const err of manifest.validationErrors ?? []) {
      const key = err.replace(/[^a-z_]/gi, "_").slice(0, 60);
      invalidityReasonCounter[key] = (invalidityReasonCounter[key] ?? 0) + 1;
    }

    // Temporal spread
    if (manifest.slotStartMs && manifest.slotStartMs > 0) {
      if (firstSlotMs === null || manifest.slotStartMs < firstSlotMs) firstSlotMs = manifest.slotStartMs;
    }
    if (manifest.slotEndMs && manifest.slotEndMs > 0) {
      if (lastSlotMs === null || manifest.slotEndMs > lastSlotMs) lastSlotMs = manifest.slotEndMs;
    }
    slugsSeen.add(manifest.slug);

    pairs.push({
      slug: manifest.slug,
      pairValidity: manifest.pairValidity,
      coverageVerdict: manifest.coverageVerdict,
      rawL2EventCount: manifest.rawL2EventCount,
      rawL2TradeEventCount: manifest.rawL2TradeEventCount,
      rawL2BookEventCount: manifest.rawL2BookEventCount,
      replayEventCount: manifest.replayEventCount,
      recorderStopReason: manifest.recorderStopReason,
      recorderCompletedEventSeen: manifest.recorderCompletedEventSeen,
      validationErrorCount: manifest.validationErrors.length,
      validationWarningCount: manifest.validationWarnings.length,
      validationErrors: manifest.validationErrors,
      validationWarnings: manifest.validationWarnings,
      parseErrorCount: manifest.parseErrors.length,
    });
  }

  const totalPairManifests = pairFiles.length;

  // --- No pairs found ---
  if (totalPairManifests === 0) {
    failReasons.push("No pair manifests found in pairs directory");
  }

  // --- Valid pair count vs minimum ---
  if (validPairCount < minValidPairs) {
    failReasons.push(
      `Valid pair count (${validPairCount}) is below requested minimum (${minValidPairs})`
    );
  }

  // --- Invalid >= valid threshold (after ≥10 total) ---
  if (totalPairManifests >= 10 && invalidPairCount >= validPairCount) {
    failReasons.push(
      `Invalid pairs (${invalidPairCount}) >= valid pairs (${validPairCount}) after ${totalPairManifests} total pairs`
    );
  }

  // --- Raw L2 trade events warn ---
  if (totalRawL2TradeEvents < 1000 && validPairCount > 0) {
    warnReasons.push(
      `Low raw L2 trade events across corpus (${totalRawL2TradeEvents}). Markout quality may be limited.`
    );
  }

  // --- Temporal spread warn ---
  const approxHoursCovered =
    firstSlotMs !== null && lastSlotMs !== null
      ? (lastSlotMs - firstSlotMs) / (1000 * 60 * 60)
      : 0;
  if (approxHoursCovered < 2 && validPairCount > 0) {
    warnReasons.push(
      `Temporal spread is weak (${approxHoursCovered.toFixed(1)} hours). Temporal-split calibration requires ≥2 hours spread.`
    );
  }

  // --- Load calibration records if supplied ---
  let totalCalibrationRecords = 0;
  let missingDecisionFeatureCount = 0;
  let missingModelProbabilityCount = 0;
  let missingFairValueEdgeCount = 0;
  let missingMarkoutCount = 0;
  let missingChainlinkAnchorRecordCount = 0;
  let tradePrintBackedCount = 0;
  let touchOnlyCount = 0;
  let noFillCount = 0;

  const missingDataCounter: Record<string, number> = {};

  let records: CalibrationRecord[] = [];
  if (calibrationJsonlPath && existsSync(calibrationJsonlPath)) {
    records = parseCalibrationJsonl(calibrationJsonlPath);
    totalCalibrationRecords = records.length;

    for (const record of records) {
      for (const reason of record.dataQuality?.missingReasons ?? []) {
        missingDataCounter[reason] = (missingDataCounter[reason] ?? 0) + 1;
        if (reason === "missing_decision_feature") missingDecisionFeatureCount++;
        if (reason === "missing_model_probability") missingModelProbabilityCount++;
        if (reason === "missing_fair_value_edge") missingFairValueEdgeCount++;
        if (
          reason === "missing_markout_1s" ||
          reason === "missing_markout_5s" ||
          reason === "missing_markout_30s"
        ) {
          missingMarkoutCount++;
        }
        if (reason === "missing_chainlink_anchor") missingChainlinkAnchorRecordCount++;
      }

      if (record.fillTsMs !== undefined) {
        if (record.dataQuality?.hasMarketTradeEvidence) {
          tradePrintBackedCount++;
        } else {
          touchOnlyCount++;
        }
      } else {
        noFillCount++;
      }
    }

    // Missing decision feature rate
    const missingFeatureRate =
      totalCalibrationRecords > 0
        ? missingDecisionFeatureCount / totalCalibrationRecords
        : null;

    if (missingFeatureRate !== null && missingFeatureRate > 0.05) {
      failReasons.push(
        `Missing decision feature rate is ${(missingFeatureRate * 100).toFixed(1)}% (threshold: 5%). Corpus replay usefulness is degraded.`
      );
    }

    // Missing Chainlink anchor in calibration records
    if (missingChainlinkAnchorRecordCount > 0) {
      failReasons.push(
        `${missingChainlinkAnchorRecordCount} calibration records have missing_chainlink_anchor. Settlement truth is incomplete.`
      );
    }

    // Touch-only warn
    if (totalCalibrationRecords > 0) {
      const touchOnlyRate = touchOnlyCount / totalCalibrationRecords;
      if (touchOnlyRate > 0.5) {
        warnReasons.push(
          `Touch-only records are ${(touchOnlyRate * 100).toFixed(0)}% of calibration corpus. Trade-print-backed records are preferred for calibration.`
        );
      }
    }
  }

  // --- Compute missing decision feature rate ---
  const missingDecisionFeatureRate =
    totalCalibrationRecords > 0
      ? missingDecisionFeatureCount / totalCalibrationRecords
      : null;

  // --- Verdict ---
  let decision: CaptureQualityDecision;
  if (failReasons.length > 0) {
    decision = "capture_quality_fail";
  } else if (warnReasons.length > 0) {
    decision = "capture_quality_warn";
  } else {
    decision = "capture_quality_pass";
  }

  return {
    generatedAtMs: Date.now(),
    pairsDir,
    totalPairManifests,
    validPairCount,
    invalidPairCount,
    validToInvalidRatio:
      invalidPairCount > 0 ? validPairCount / invalidPairCount : validPairCount > 0 ? Infinity : null,
    completeCoverageCount,
    incompleteCoverageCount,
    totalRawL2Events,
    totalRawL2TradeEvents,
    totalRawL2BookEvents,
    totalReplayEvents,
    recorderStopReasonCounts,
    missingChainlinkAnchorPairCount,
    staleOrDegradedChainlinkPairCount,
    totalCalibrationRecords,
    missingDecisionFeatureCount,
    missingModelProbabilityCount,
    missingFairValueEdgeCount,
    missingMarkoutCount,
    missingChainlinkAnchorRecordCount,
    tradePrintBackedCount,
    touchOnlyCount,
    noFillCount,
    missingDecisionFeatureRate,
    topInvalidityReasons: topN(invalidityReasonCounter),
    topMissingDataReasons: topN(missingDataCounter),
    temporalSpread: {
      firstSlotMs,
      lastSlotMs,
      approxHoursCovered,
      uniqueSlugs: slugsSeen.size,
    },
    failReasons,
    warnReasons,
    decision,
    pairs,
  };
}

// ── Markdown rendering ────────────────────────────────────────────────────────

export function renderMarkdown(report: CaptureQualityAuditReport): string {
  const lines: string[] = [];
  const ts = new Date(report.generatedAtMs).toISOString();
  const decisionIcon =
    report.decision === "capture_quality_pass"
      ? "✅"
      : report.decision === "capture_quality_warn"
        ? "⚠️"
        : "❌";

  lines.push(`# Capture Quality Audit — ${ts}`);
  lines.push("");
  lines.push(`## Decision: ${decisionIcon} \`${report.decision}\``);
  lines.push("");

  if (report.failReasons.length > 0) {
    lines.push("### ❌ Fail Reasons");
    for (const r of report.failReasons) lines.push(`- ${r}`);
    lines.push("");
  }
  if (report.warnReasons.length > 0) {
    lines.push("### ⚠️ Warn Reasons");
    for (const r of report.warnReasons) lines.push(`- ${r}`);
    lines.push("");
  }

  lines.push("## Pair Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total pair manifests | ${report.totalPairManifests} |`);
  lines.push(`| Valid pairs | ${report.validPairCount} |`);
  lines.push(`| Invalid pairs | ${report.invalidPairCount} |`);
  lines.push(`| Complete coverage | ${report.completeCoverageCount} |`);
  lines.push(`| Incomplete coverage | ${report.incompleteCoverageCount} |`);
  lines.push(`| Total raw L2 events | ${report.totalRawL2Events.toLocaleString()} |`);
  lines.push(`| Total raw L2 trade events | ${report.totalRawL2TradeEvents.toLocaleString()} |`);
  lines.push(`| Total raw L2 book events | ${report.totalRawL2BookEvents.toLocaleString()} |`);
  lines.push(`| Total replay events | ${report.totalReplayEvents.toLocaleString()} |`);
  lines.push("");

  lines.push("## Temporal Spread");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(
    `| First slot | ${report.temporalSpread.firstSlotMs ? new Date(report.temporalSpread.firstSlotMs).toISOString() : "N/A"} |`
  );
  lines.push(
    `| Last slot | ${report.temporalSpread.lastSlotMs ? new Date(report.temporalSpread.lastSlotMs).toISOString() : "N/A"} |`
  );
  lines.push(`| Hours covered | ${report.temporalSpread.approxHoursCovered.toFixed(1)} |`);
  lines.push(`| Unique slugs | ${report.temporalSpread.uniqueSlugs} |`);
  lines.push("");

  lines.push("## Recorder Stop Reasons");
  lines.push("");
  lines.push(`| Reason | Count |`);
  lines.push(`|--------|-------|`);
  for (const [reason, count] of Object.entries(report.recorderStopReasonCounts)) {
    lines.push(`| ${reason} | ${count} |`);
  }
  lines.push("");

  if (report.totalCalibrationRecords > 0) {
    lines.push("## Calibration Record Quality");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total records | ${report.totalCalibrationRecords} |`);
    lines.push(`| Trade-print-backed | ${report.tradePrintBackedCount} |`);
    lines.push(`| Touch-only | ${report.touchOnlyCount} |`);
    lines.push(`| No-fill | ${report.noFillCount} |`);
    lines.push(`| Missing decision feature | ${report.missingDecisionFeatureCount} |`);
    lines.push(`| Missing model probability | ${report.missingModelProbabilityCount} |`);
    lines.push(`| Missing fair-value edge | ${report.missingFairValueEdgeCount} |`);
    lines.push(`| Missing markout (any) | ${report.missingMarkoutCount} |`);
    lines.push(`| Missing Chainlink anchor | ${report.missingChainlinkAnchorRecordCount} |`);
    if (report.missingDecisionFeatureRate !== null) {
      lines.push(
        `| Missing decision feature rate | ${(report.missingDecisionFeatureRate * 100).toFixed(1)}% |`
      );
    }
    lines.push("");
  }

  if (report.topInvalidityReasons.length > 0) {
    lines.push("## Top Invalidity Reasons");
    lines.push("");
    lines.push(`| Reason | Count |`);
    lines.push(`|--------|-------|`);
    for (const { reason, count } of report.topInvalidityReasons) {
      lines.push(`| ${reason} | ${count} |`);
    }
    lines.push("");
  }

  if (report.topMissingDataReasons.length > 0) {
    lines.push("## Top Missing-Data Reasons");
    lines.push("");
    lines.push(`| Reason | Count |`);
    lines.push(`|--------|-------|`);
    for (const { reason, count } of report.topMissingDataReasons) {
      lines.push(`| ${reason} | ${count} |`);
    }
    lines.push("");
  }

  if (report.pairs.length > 0) {
    lines.push("## Pair Detail");
    lines.push("");
    lines.push(
      `| Slug | Validity | Coverage | L2 Events | Trade Events | Stop Reason | Errors | Warnings |`
    );
    lines.push(
      `|------|----------|----------|-----------|--------------|-------------|--------|----------|`
    );
    for (const p of report.pairs) {
      lines.push(
        `| ${p.slug} | ${p.pairValidity} | ${p.coverageVerdict} | ${p.rawL2EventCount} | ${p.rawL2TradeEventCount} | ${p.recorderStopReason ?? "?"} | ${p.validationErrorCount} | ${p.validationWarningCount} |`
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "_Generated by `scripts/audit-capture-quality.ts` — Phase 8U capture quality hardening._"
  );
  lines.push("_No live execution behavior was changed. No profitability claim. No model-readiness claim._");
  lines.push("");

  return lines.join("\n");
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let pairsDir = "data/pairs";
  let calibrationJsonlPath: string | undefined;
  let outJson: string | undefined;
  let outMd: string | undefined;
  let minValidPairs = 1;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pairs-dir") pairsDir = args[++i] ?? pairsDir;
    else if (arg === "--calibration-jsonl") calibrationJsonlPath = args[++i];
    else if (arg === "--out-json") outJson = args[++i];
    else if (arg === "--out-md") outMd = args[++i];
    else if (arg === "--min-valid-pairs") minValidPairs = parseInt(args[++i] ?? "1", 10);
    else if (arg === "--dry-run") dryRun = true;
  }

  console.log(`[AuditCaptureQuality] Auditing pairs from: ${pairsDir}`);
  if (calibrationJsonlPath) {
    console.log(`[AuditCaptureQuality] Using calibration records from: ${calibrationJsonlPath}`);
  }

  const report = runCaptureQualityAudit({ pairsDir, calibrationJsonlPath, minValidPairs });

  const jsonOutput = JSON.stringify(report, null, 2);
  const mdOutput = renderMarkdown(report);

  if (!dryRun) {
    if (outJson) {
      mkdirSync(path.dirname(outJson), { recursive: true });
      writeFileSync(outJson, jsonOutput, "utf-8");
      console.log(`[AuditCaptureQuality] JSON report written to: ${outJson}`);
    }
    if (outMd) {
      mkdirSync(path.dirname(outMd), { recursive: true });
      writeFileSync(outMd, mdOutput, "utf-8");
      console.log(`[AuditCaptureQuality] Markdown report written to: ${outMd}`);
    }
  } else {
    console.log("[AuditCaptureQuality] Dry run — no files written.");
  }

  // Print summary to stdout
  console.log("");
  console.log(`Decision: ${report.decision}`);
  console.log(`Total pairs: ${report.totalPairManifests}`);
  console.log(`Valid: ${report.validPairCount} | Invalid: ${report.invalidPairCount}`);
  console.log(`Complete coverage: ${report.completeCoverageCount}`);
  console.log(`Total raw L2 events: ${report.totalRawL2Events.toLocaleString()}`);
  console.log(`Total raw L2 trade events: ${report.totalRawL2TradeEvents.toLocaleString()}`);

  if (report.failReasons.length > 0) {
    console.log("\nFail reasons:");
    for (const r of report.failReasons) console.log(`  ✗ ${r}`);
  }
  if (report.warnReasons.length > 0) {
    console.log("\nWarn reasons:");
    for (const r of report.warnReasons) console.log(`  ⚠ ${r}`);
  }

  // Exit with non-zero if fail
  if (report.decision === "capture_quality_fail") {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[AuditCaptureQuality] Fatal error:", err);
    process.exit(1);
  });
}
