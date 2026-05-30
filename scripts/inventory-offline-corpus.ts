import { readFileSync, writeFileSync } from "fs";
import { parseArgs } from "util";
import type { CalibrationRecord } from "../engine/replay/calibration-extractor.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "out-json": {
      type: "string",
    },
  },
  allowPositionals: true,
});

const inputPath = positionals[0] || "data/reports/phase8o-calibration.jsonl";

let totalRecords = 0;
let malformedRows = 0;

const pairs = new Set<string>();
const slugs = new Set<string>();
const recordsPerPair = new Map<string, number>();

let minTs = Infinity;
let maxTs = -Infinity;

const variants = new Set<string>();

let fillEvidenceCount = 0;
let tradePrintBackedCount = 0;
let touchOnlyCount = 0;

let missingDecisionFeatureCount = 0;

// Missing Labels
let missingAdverseSelection = 0;
let missingMarkout1s = 0;
let missingMarkout5s = 0;
let missingMarkout30s = 0;

// Missing Pre-trade features
let missingModelProbability = 0;
let missingFairValueEdge = 0;

try {
  const content = readFileSync(inputPath, "utf-8");
  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = (rawLine || "").trim();
    if (!line) continue;
    
    totalRecords++;
    
    let record: CalibrationRecord;
    try {
      record = JSON.parse(line);
      // Basic validation
      if (!record.schemaVersion || !record.slug) {
        malformedRows++;
        continue;
      }
    } catch (e) {
      malformedRows++;
      continue;
    }

    if (record.pairManifestPath) {
      pairs.add(record.pairManifestPath);
      recordsPerPair.set(record.pairManifestPath, (recordsPerPair.get(record.pairManifestPath) || 0) + 1);
    }
    
    slugs.add(record.slug);
    
    if (record.variantId) {
      variants.add(record.variantId);
    } else if (record.variantName) {
      variants.add(record.variantName);
    }

    const ts = record.fillTsMs || record.quoteTsMs || record.decisionTsMs;
    if (ts) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }

    // Checking if it's a fill evidence
    if (record.fillPrice !== undefined && record.fillPrice !== null) {
      fillEvidenceCount++;
      if (record.dataQuality?.hasMarketTradeEvidence) {
        tradePrintBackedCount++;
      } else {
        touchOnlyCount++;
      }
    } else if (record.fillTsMs !== undefined) {
      fillEvidenceCount++;
      if (record.dataQuality?.hasMarketTradeEvidence) {
        tradePrintBackedCount++;
      } else {
        touchOnlyCount++;
      }
    }

    const missingReasons = record.dataQuality?.missingReasons || [];
    if (missingReasons.includes("missing_decision_feature")) {
      missingDecisionFeatureCount++;
    }
    if (missingReasons.includes("missing_model_probability")) {
      missingModelProbability++;
    }
    if (missingReasons.includes("missing_fair_value_edge")) {
      missingFairValueEdge++;
    }

    if (record.adverseSelection === null || record.adverseSelection === undefined) {
      missingAdverseSelection++;
    }
    if (!record.dataQuality?.hasMarkout1s) {
      missingMarkout1s++;
    }
    if (!record.dataQuality?.hasMarkout5s) {
      missingMarkout5s++;
    }
    if (!record.dataQuality?.hasMarkout30s) {
      missingMarkout30s++;
    }
  }
} catch (e) {
  console.error("Error reading file:", e);
  process.exit(1);
}

const summary = {
  totalRecords,
  malformedRows,
  pairCount: pairs.size,
  recordsPerPair: Object.fromEntries(recordsPerPair),
  marketSlugCoverage: slugs.size,
  temporalCoverage: {
    earliest: minTs !== Infinity ? new Date(minTs).toISOString() : null,
    latest: maxTs !== -Infinity ? new Date(maxTs).toISOString() : null,
  },
  variantCount: variants.size,
  fillEvidenceCount,
  tradePrintBackedCount,
  touchOnlyCount,
  missingDecisionFeatureCount,
  missingLabelCounts: {
    adverseSelection: missingAdverseSelection,
    markout1s: missingMarkout1s,
    markout5s: missingMarkout5s,
    markout30s: missingMarkout30s,
  },
  missingPreTradeFeatureCounts: {
    modelProbability: missingModelProbability,
    fairValueEdge: missingFairValueEdge,
  }
};

console.log(JSON.stringify(summary, null, 2));

if (values["out-json"]) {
  writeFileSync(values["out-json"], JSON.stringify(summary, null, 2));
  console.log(`Wrote summary to ${values["out-json"]}`);
}
