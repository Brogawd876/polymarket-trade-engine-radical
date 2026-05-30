import { parseArgs } from "util";
import { readFileSync, writeFileSync } from "fs";
import { runCalibrationAudit } from "../engine/replay/calibration-audit.ts";
import type { CalibrationRecord } from "../engine/replay/calibration-extractor.ts";
import type { CalibrationCandidate } from "../engine/replay/calibration-feature-comparison.ts";

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    input: { type: "string" },
    "out-json": { type: "string" },
    "out-md": { type: "string" },
    "train-ratio": { type: "string", default: "0.7" },
  },
  strict: true,
  allowPositionals: true,
});

if (!values.input) {
  console.error("Usage: bun scripts/audit-offline-calibration.ts --input <file.jsonl> [--out-json <file.json>] [--out-md <file.md>]");
  process.exit(1);
}

const inputPath = values.input;
let records: CalibrationRecord[] = [];
try {
  const content = readFileSync(inputPath, "utf-8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line));
  }
} catch (err) {
  console.error(`Error reading ${inputPath}:`, err);
  process.exit(1);
}

const candidates: CalibrationCandidate[] = [
  { scoreField: "modelProbability", labelField: "adverseMarkout30s" },
  { scoreField: "fairValue", labelField: "adverseMarkout30s" },
  { scoreField: "spread", labelField: "adverseMarkout30s" },
  { scoreField: "markout1s", labelField: "adverseMarkout30s" },
  { scoreField: "predictiveDivergence", labelField: "adverseMarkout30s" },
  { scoreField: "bestBid", labelField: "adverseMarkout30s" },
];

const audit = runCalibrationAudit(records, candidates, {
  trainRatio: parseFloat(values["train-ratio"] as string),
  minTrainSamples: 50,
  minHoldoutSamples: 20,
});

if (values["out-json"]) {
  writeFileSync(values["out-json"], JSON.stringify(audit, null, 2));
  console.log(`Wrote JSON report to ${values["out-json"]}`);
}

if (values["out-md"]) {
  let md = `# Phase 8Q: Calibration Audit Report\n\n`;
  md += `## Executive Summary\n`;
  md += `Total records processed: ${audit.totalRecords}\n\n`;
  
  md += `## Dataset Coverage\n`;
  for (const seg of audit.segments) {
    md += `- Split: ${seg.splitMode}, Filter: ${seg.evidenceFilter}, Valid Segments: ${seg.summary.candidates.filter(c=>c.status === "ok").length}\n`;
  }
  md += `\n`;

  md += `## Segment Comparison\n`;
  for (const seg of audit.segments) {
    if (seg.summary.candidates.length > 0) {
      md += `### ${seg.splitMode} split, ${seg.evidenceFilter} evidence\n`;
      md += `Records in segment: ${seg.summary.totalRecords}\n`;
      for (const cand of seg.auditedCandidates) {
        if (cand.status === "ok") {
          md += `- **${cand.scoreField}** -> ${cand.labelField}: Train/Holdout Samples ${cand.trainSampleCount}/${cand.holdoutSampleCount}, Brier Holdout ${cand.holdoutMetrics.brierScore?.toFixed(4)}\n`;
        }
      }
    }
  }
  md += `\n`;

  md += `## Leakage / Diagnostic-Only Features\n`;
  for (const seg of audit.segments) {
    if (seg.splitMode === "temporal" && seg.evidenceFilter === "all") {
      for (const cand of seg.auditedCandidates) {
        if (cand.classification === "diagnostic_only") {
          md += `- **${cand.scoreField}**: ${cand.classificationReason}\n`;
        }
      }
      break;
    }
  }
  md += `\n`;

  md += `## Rejected / Insufficient Candidates\n`;
  for (const seg of audit.segments) {
    if (seg.splitMode === "temporal" && seg.evidenceFilter === "all") {
      for (const cand of seg.auditedCandidates) {
        if (cand.status === "insufficient_data") {
          md += `- **${cand.scoreField}**: ${cand.classificationReason}\n`;
        }
      }
      break;
    }
  }
  md += `\n`;

  md += `## Candidate Leaderboard\n`;
  // Best pre_trade_candidate based on Brier
  let bestCandidate = null;
  let bestBrier = Infinity;
  for (const seg of audit.segments) {
    if (seg.splitMode === "temporal" && seg.evidenceFilter === "all") {
      for (const cand of seg.auditedCandidates) {
        if (cand.classification === "pre_trade_candidate" && cand.status === "ok" && cand.holdoutMetrics.brierScore !== null && cand.holdoutMetrics.brierScore < bestBrier) {
          bestBrier = cand.holdoutMetrics.brierScore;
          bestCandidate = cand;
        }
      }
      break;
    }
  }
  if (bestCandidate) {
    md += `Top Candidate: **${bestCandidate.scoreField}** with Brier Score: ${bestBrier.toFixed(4)}\n\n`;
  } else {
    md += `No viable pre-trade candidates found.\n\n`;
  }

  md += `## Recommended Next Action\n`;
  md += `Verify stability and sample sizes before gating live execution.\n\n`;

  md += `## Explicit Non-Claims\n`;
  md += `- This audit does not claim profitability.\n`;
  md += `- Live execution and risk gates have not been modified.\n`;
  
  writeFileSync(values["out-md"], md);
  console.log(`Wrote Markdown report to ${values["out-md"]}`);
}

console.log(`Audit complete. Processed ${audit.totalRecords} records across ${audit.segments.length} segments.`);
