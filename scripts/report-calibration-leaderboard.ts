import { readFileSync } from "fs";
import type { CalibrationFeatureComparisonSummary } from "../engine/replay/calibration-feature-comparison.ts";

function parseArgs(): { inputJson: string; metric: "brier" | "ece" } {
  const args = process.argv.slice(2);
  let inputJson = "";
  let metric: "brier" | "ece" = "brier";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--input") {
      inputJson = args[++i] || "";
    } else if (arg === "--metric") {
      const val = args[++i];
      if (val === "brier" || val === "ece") {
        metric = val;
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: bun scripts/report-calibration-leaderboard.ts [options]
Options:
  --input <path>     JSON output from compare-offline-calibration-features.ts
  --metric <brier|ece> Rank by Holdout Brier Score or ECE (default: brier)
      `);
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      inputJson = arg;
    }
  }

  if (!inputJson) {
    throw new Error("Missing input JSON file. Use --input <path>");
  }

  return { inputJson, metric };
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "N/A";
  return n.toFixed(6);
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "N/A";
  return (n * 100).toFixed(2) + "%";
}

function main() {
  const { inputJson, metric } = parseArgs();
  const data = JSON.parse(readFileSync(inputJson, "utf-8")) as CalibrationFeatureComparisonSummary;

  console.log(`=== Offline Calibration Leaderboard ===`);
  console.log(`Evidence Segment: ${data.evidenceFilter || "all"}`);
  console.log(`Split Mode: ${data.splitMode} (Train Ratio: ${data.trainRatio})`);
  console.log(`Total Records: ${data.totalRecords}\n`);

  const validCandidates = data.candidates.filter(c => c.status === "ok" && c.holdoutMetrics);

  validCandidates.sort((a, b) => {
    let scoreA = metric === "brier" ? a.holdoutMetrics.brierScore : a.holdoutMetrics.expectedCalibrationError;
    let scoreB = metric === "brier" ? b.holdoutMetrics.brierScore : b.holdoutMetrics.expectedCalibrationError;
    if (scoreA === null) scoreA = Infinity;
    if (scoreB === null) scoreB = Infinity;
    return scoreA - scoreB;
  });

  console.log("Ranked Features:");
  console.log("=".repeat(120));

  let rank = 1;
  for (const c of validCandidates) {
    const isMarkout = c.scoreField.startsWith("markout");
    let featureName = c.scoreField;
    if (isMarkout) {
      featureName += " (DIAGNOSTIC ONLY)";
    }
    
    console.log(`${rank}. ${featureName} -> ${c.labelField}`);
    console.log(`   Sample Count: ${c.trainSampleCount} train / ${c.holdoutSampleCount} holdout`);
    console.log(`   Missing Data: ${c.extraction.missingScoreCount} scores missing / ${c.extraction.missingLabelCount} labels missing`);
    console.log(`   Positive Rate: ${fmtPct(c.positiveLabelRate)}`);
    console.log(`   Train Metrics: Brier=${fmt(c.trainMetrics?.brierScore)}, ECE=${fmt(c.trainMetrics?.expectedCalibrationError)}, LogLoss=${fmt(c.trainMetrics?.logLoss)}`);
    console.log(`   Holdout Metrics: Brier=${fmt(c.holdoutMetrics?.brierScore)}, ECE=${fmt(c.holdoutMetrics?.expectedCalibrationError)}, LogLoss=${fmt(c.holdoutMetrics?.logLoss)}`);
    
    const brierDelta = (c.holdoutMetrics?.brierScore !== null && c.trainMetrics?.brierScore !== null && c.trainMetrics?.brierScore !== undefined && c.holdoutMetrics?.brierScore !== undefined) 
        ? (c.holdoutMetrics.brierScore - c.trainMetrics.brierScore) : null;
    const eceDelta = (c.holdoutMetrics?.expectedCalibrationError !== null && c.trainMetrics?.expectedCalibrationError !== null && c.trainMetrics?.expectedCalibrationError !== undefined && c.holdoutMetrics?.expectedCalibrationError !== undefined)
        ? (c.holdoutMetrics.expectedCalibrationError - c.trainMetrics.expectedCalibrationError) : null;

    console.log(`   Train/Holdout Delta: Brier Delta=${fmt(brierDelta)}, ECE Delta=${fmt(eceDelta)}`);
    
    if (c.bucketStability) {
      console.log(`   Buckets: ${c.bucketStability.trainBucketCount} train buckets / ${c.bucketStability.populatedHoldoutBuckets} populated holdout buckets`);
      console.log(`   Bucket Stability: weightedAbsRateDelta=${fmt(c.bucketStability.weightedAbsRateDelta)}`);
    } else {
      console.log(`   Buckets: ${c.buckets.length} train buckets / N/A populated holdout buckets`);
      console.log(`   Bucket Stability: N/A`);
    }

    if (c.featureWarning) {
      console.log(`   Warning: ${c.featureWarning}`);
    }
    console.log("-".repeat(120));
    rank++;
  }

  const invalidCandidates = data.candidates.filter(c => c.status !== "ok");
  if (invalidCandidates.length > 0) {
    console.log("\nSkipped/Insufficient Data:");
    for (const c of invalidCandidates) {
      console.log(` - ${c.scoreField} -> ${c.labelField}: ${c.reason || "Unknown"}`);
    }
  }
}

main();
