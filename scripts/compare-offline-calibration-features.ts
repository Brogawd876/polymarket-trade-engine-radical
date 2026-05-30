import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import type { CalibrationRecord } from "../engine/replay/calibration-extractor.ts";
import {
  type CalibrationFeatureComparisonSummary,
  compareCalibrationFeatures,
  filterRecordsByEvidence,
  type CalibrationCandidate,
  type CalibrationLabelName,
} from "../engine/replay/calibration-feature-comparison.ts";

type Args = {
  input: string;
  outJson: string;
  scoreFields: string[];
  labelFields: CalibrationLabelName[];
  splitMode: "row" | "temporal";
  evidenceFilter: "all" | "trade-print-backed" | "touch-only" | "missing-decision-feature-excluded";
  trainRatio: number;
  temporalCutoffMs?: number;
  minTrainSamples: number;
  minHoldoutSamples: number;
};

const DEFAULT_SCORE_FIELDS = [
  "modelProbability",
  "rawProbability",
  "fairValue",
  "marketImpliedProbability",
  "quotedEdge",
  "fairValueEdge",
  "spread",
  "bestBid",
  "bestAsk",
  "topOfBookLiquidity",
  "timeToCloseMs",
  "volatilityEstimate",
  "predictiveDivergence",
  "resolutionDistance",
  "distanceToOpenAnchor",
  "predictedProbability",
  "fillPrice",
  "markout1s",
  "markout5s",
  "markout30s",
];

const DEFAULT_LABEL_FIELDS: CalibrationLabelName[] = [
  "adverseSelection",
  "profitableMarkout1s",
  "profitableMarkout5s",
  "profitableMarkout30s",
  "adverseMarkout1s",
  "adverseMarkout5s",
  "adverseMarkout30s",
];

function parseCsv(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const parsed: Args = {
    input: "data/reports/phase8l-calibration.jsonl",
    outJson: "",
    scoreFields: DEFAULT_SCORE_FIELDS,
    labelFields: DEFAULT_LABEL_FIELDS,
    splitMode: "row",
    evidenceFilter: "all",
    trainRatio: 0.7,
    minTrainSamples: 30,
    minHoldoutSamples: 10,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input") parsed.input = args[++i] || parsed.input;
    else if (arg === "--out-json") parsed.outJson = args[++i] || parsed.outJson;
    else if (arg === "--score-fields") parsed.scoreFields = parseCsv(args[++i] || "");
    else if (arg === "--label-fields") parsed.labelFields = parseCsv(args[++i] || "") as CalibrationLabelName[];
    else if (arg === "--split-mode") parsed.splitMode = args[++i] as "row" | "temporal";
    else if (arg === "--evidence-filter") parsed.evidenceFilter = (args[++i] || "all") as Args["evidenceFilter"];
    else if (arg === "--train-ratio") parsed.trainRatio = Number.parseFloat(args[++i] || String(parsed.trainRatio));
    else if (arg === "--temporal-cutoff-ms") parsed.temporalCutoffMs = Number.parseInt(args[++i] || "", 10);
    else if (arg === "--min-train-samples") parsed.minTrainSamples = Number.parseInt(args[++i] || String(parsed.minTrainSamples), 10);
    else if (arg === "--min-holdout-samples") parsed.minHoldoutSamples = Number.parseInt(args[++i] || String(parsed.minHoldoutSamples), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: bun scripts/compare-offline-calibration-features.ts [options]",
        "",
        "Options:",
        "  --input <path>                  CalibrationRecord JSONL input",
        "  --out-json <path>               Optional JSON summary output",
        "  --score-fields <csv>            Numeric score fields or dotted paths",
        "  --label-fields <csv>            Labels: adverseSelection, profitableMarkout1s/5s/30s, adverseMarkout1s/5s/30s",
        "  --split-mode <row|temporal>     Split method, default row",
        "  --evidence-filter <filter>      all | trade-print-backed | touch-only | missing-decision-feature-excluded",
        "  --train-ratio <n>               Train split ratio, default 0.7",
        "  --temporal-cutoff-ms <ms>       Optional absolute cutoff ms for temporal split",
        "  --min-train-samples <n>         Minimum train rows per candidate",
        "  --min-holdout-samples <n>       Minimum holdout rows per candidate",
      ].join("\n"));
      process.exit(0);
    }
  }

  if (!Number.isFinite(parsed.trainRatio) || parsed.trainRatio <= 0 || parsed.trainRatio >= 1) {
    throw new Error(`Invalid --train-ratio: ${parsed.trainRatio}`);
  }
  if (!Number.isFinite(parsed.minTrainSamples) || parsed.minTrainSamples < 1) {
    throw new Error(`Invalid --min-train-samples: ${parsed.minTrainSamples}`);
  }
  if (!Number.isFinite(parsed.minHoldoutSamples) || parsed.minHoldoutSamples < 1) {
    throw new Error(`Invalid --min-holdout-samples: ${parsed.minHoldoutSamples}`);
  }
  if (parsed.scoreFields.length === 0) throw new Error("At least one score field is required.");
  if (parsed.labelFields.length === 0) throw new Error("At least one label field is required.");

  return parsed;
}

function readCalibrationJsonl(file: string): { records: CalibrationRecord[]; malformedRows: number } {
  if (!existsSync(file)) throw new Error(`Calibration input not found: ${file}`);

  const records: CalibrationRecord[] = [];
  let malformedRows = 0;
  const lines = readFileSync(file, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as CalibrationRecord);
    } catch {
      malformedRows++;
    }
  }
  return { records, malformedRows };
}

function fmt(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : value.toFixed(6);
}

function printSummary(summary: ReturnType<typeof compareCalibrationFeatures>, malformedRows: number): void {
  console.log(`Offline calibration feature comparison status: ${summary.status}`);
  console.log(`Total records: ${summary.totalRecords}`);
  console.log(`Malformed rows: ${malformedRows}`);
  console.log(`Train ratio: ${summary.trainRatio}`);
  console.log(`Split mode: ${summary.splitMode}`);
  if (summary.evidenceFilter) {
    console.log(`Evidence filter: ${summary.evidenceFilter}`);
  }
  if (summary.temporalCutoffMs) {
    console.log(`Temporal cutoff ms: ${summary.temporalCutoffMs} (${new Date(summary.temporalCutoffMs).toISOString()})`);
  }
  console.log(`Min train/holdout: ${summary.minTrainSamples}/${summary.minHoldoutSamples}`);
  console.log("");
  console.log([
    "score",
    "label",
    "status",
    "train",
    "holdout",
    "positive",
    "missScore",
    "missLabel",
    "holdoutBrier",
    "holdoutLogLoss",
    "holdoutECE",
    "bucketDelta",
    "buckets",
    "warning",
    "reason",
  ].join("\t"));

  for (const result of summary.candidates) {
    console.log([
      result.scoreField,
      result.labelField,
      result.status,
      result.trainSampleCount,
      result.holdoutSampleCount,
      fmt(result.positiveLabelRate),
      result.extraction.missingScoreCount,
      result.extraction.missingLabelCount,
      fmt(result.holdoutMetrics.brierScore),
      fmt(result.holdoutMetrics.logLoss),
      fmt(result.holdoutMetrics.expectedCalibrationError),
      fmt(result.bucketStability?.weightedAbsRateDelta),
      result.buckets.length,
      result.featureWarning ?? "",
      result.reason ?? "",
    ].join("\t"));
  }
}

async function main() {
  const args = parseArgs();
  let { records, malformedRows } = readCalibrationJsonl(args.input);
  
  records = filterRecordsByEvidence(records, args.evidenceFilter);

  const candidates: CalibrationCandidate[] = args.scoreFields.flatMap((scoreField) =>
    args.labelFields.map((labelField) => ({ scoreField, labelField })),
  );

  const summary = compareCalibrationFeatures(records, candidates, {
    splitMode: args.splitMode,
    evidenceFilter: args.evidenceFilter,
    trainRatio: args.trainRatio,
    temporalCutoffMs: args.temporalCutoffMs,
    minTrainSamples: args.minTrainSamples,
    minHoldoutSamples: args.minHoldoutSamples,
  });
  printSummary(summary, malformedRows);

  if (args.outJson) {
    mkdirSync(path.dirname(args.outJson), { recursive: true });
    writeFileSync(args.outJson, JSON.stringify({ ...summary, malformedRows }, null, 2), "utf-8");
    console.log(`\nWrote summary JSON: ${args.outJson}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
