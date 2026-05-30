import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import type { CalibrationRecord } from "../engine/replay/calibration-extractor.ts";
import { runOfflineIsotonicCalibration } from "../engine/replay/calibration-metrics.ts";

type Args = {
  input: string;
  outJson: string;
  scoreField: string;
  labelField: string;
  minSamples: number;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const parsed: Args = {
    input: "data/reports/phase8l-calibration.jsonl",
    outJson: "",
    scoreField: "fillPrice",
    labelField: "adverseSelection",
    minSamples: 30,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input") parsed.input = args[++i] || parsed.input;
    else if (arg === "--out-json") parsed.outJson = args[++i] || parsed.outJson;
    else if (arg === "--score-field") parsed.scoreField = args[++i] || parsed.scoreField;
    else if (arg === "--label-field") parsed.labelField = args[++i] || parsed.labelField;
    else if (arg === "--min-samples") parsed.minSamples = Number.parseInt(args[++i] || String(parsed.minSamples), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: bun scripts/run-offline-calibration.ts [options]",
        "",
        "Options:",
        "  --input <path>         CalibrationRecord JSONL input",
        "  --out-json <path>      Optional JSON summary output",
        "  --score-field <field>  Numeric CalibrationRecord field or dotted path",
        "  --label-field <field>  Boolean or 0/1 CalibrationRecord field or dotted path",
        "  --min-samples <n>      Minimum valid rows required to fit",
      ].join("\n"));
      process.exit(0);
    }
  }

  if (!Number.isFinite(parsed.minSamples) || parsed.minSamples < 1) {
    throw new Error(`Invalid --min-samples: ${parsed.minSamples}`);
  }

  return parsed;
}

function readCalibrationJsonl(file: string): { records: CalibrationRecord[]; malformedRows: number } {
  if (!existsSync(file)) {
    throw new Error(`Calibration input not found: ${file}`);
  }

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

function printSummary(summary: ReturnType<typeof runOfflineIsotonicCalibration>, malformedRows: number): void {
  console.log(`Offline isotonic calibration status: ${summary.status}`);
  console.log(`Score field: ${summary.scoreField}`);
  console.log(`Label field: ${summary.labelField}`);
  console.log(`Samples: ${summary.sampleCount}`);
  console.log(`Positive-label rate: ${fmt(summary.positiveLabelRate)}`);
  console.log(`Malformed rows: ${malformedRows}`);
  console.log(`Missing/invalid: score missing=${summary.extraction.missingScoreCount}, score invalid=${summary.extraction.invalidScoreCount}, label missing=${summary.extraction.missingLabelCount}, label invalid=${summary.extraction.invalidLabelCount}`);
  if (summary.reason) console.log(`Reason: ${summary.reason}`);

  console.log(`Metrics: brier=${fmt(summary.metrics.brierScore)}, logLoss=${fmt(summary.metrics.logLoss)}, ece=${fmt(summary.metrics.expectedCalibrationError)}`);
  console.log("");
  console.log("bucket\tlower\tupper\tcount\tpositive\tempirical\tcalibrated");
  summary.buckets.forEach((bucket, index) => {
    console.log([
      index + 1,
      fmt(bucket.lowerScore),
      fmt(bucket.upperScore),
      bucket.count,
      bucket.positiveCount,
      fmt(bucket.empiricalRate),
      fmt(bucket.calibratedRate),
    ].join("\t"));
  });
}

async function main() {
  const args = parseArgs();
  const { records, malformedRows } = readCalibrationJsonl(args.input);
  const summary = runOfflineIsotonicCalibration(records, {
    scoreField: args.scoreField,
    labelField: args.labelField,
    minSamples: args.minSamples,
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
