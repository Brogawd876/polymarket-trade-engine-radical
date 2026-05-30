import { parseArgs } from "util";
import { readFileSync, writeFileSync } from "fs";
import { evaluateCalibrationReadiness } from "../engine/replay/calibration-readiness-gate.ts";
import type { CalibrationAuditSummary } from "../engine/replay/calibration-audit.ts";

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    "audit-json": { type: "string" },
    "out-json": { type: "string" },
    "out-md": { type: "string" },
  },
  strict: true,
  allowPositionals: true,
});

if (!values["audit-json"]) {
  console.error("Usage: bun scripts/evaluate-calibration-readiness.ts --audit-json <file.json> [--out-json <file.json>] [--out-md <file.md>]");
  process.exit(1);
}

const inputPath = values["audit-json"];
let auditSummary: CalibrationAuditSummary;
try {
  const content = readFileSync(inputPath, "utf-8");
  auditSummary = JSON.parse(content);
} catch (err) {
  console.error(`Error reading ${inputPath}:`, err);
  process.exit(1);
}

const readiness = evaluateCalibrationReadiness(auditSummary);

if (values["out-json"]) {
  writeFileSync(values["out-json"], JSON.stringify(readiness, null, 2));
  console.log(`Wrote JSON readiness report to ${values["out-json"]}`);
}

if (values["out-md"]) {
  let md = `# Phase 8R: Calibration Readiness Gate\n\n`;
  md += `## Executive Summary\n`;
  md += `Global Decision: **${readiness.globalDecision.toUpperCase()}**\n\n`;

  if (readiness.globalDecision === "blocked") {
    md += `No candidate passed readiness thresholds.\n`;
    md += `Current corpus is useful for pipeline testing only.\n`;
    md += `More paired, trade-print-backed, temporally separated data is required.\n`;
    md += `No live/paper automation should rely on these calibration models yet.\n\n`;
  }

  md += `## Global Failures\n`;
  if (readiness.globalFailures.length === 0) {
    md += `- None\n`;
  } else {
    for (const failure of readiness.globalFailures) {
      md += `- ${failure}\n`;
    }
  }
  md += `\n`;

  const paperCandidates = readiness.candidates.filter(c => c.decision === "paper_candidate");
  const researchOnly = readiness.candidates.filter(c => c.decision === "research_only");
  const blocked = readiness.candidates.filter(c => c.decision === "blocked");

  md += `## Paper-Candidate Candidates (${paperCandidates.length})\n`;
  if (paperCandidates.length === 0) {
    md += `- None\n`;
  } else {
    for (const cand of paperCandidates) {
      md += `- **${cand.scoreField}** (${cand.splitMode}, ${cand.evidenceFilter})\n`;
    }
  }
  md += `\n`;

  md += `## Research-Only Candidates (${researchOnly.length})\n`;
  if (researchOnly.length === 0) {
    md += `- None\n`;
  } else {
    for (const cand of researchOnly) {
      md += `- **${cand.scoreField}** (${cand.splitMode}, ${cand.evidenceFilter})\n`;
    }
  }
  md += `\n`;

  md += `## Blocked Candidates (${blocked.length})\n`;
  if (blocked.length === 0) {
    md += `- None\n`;
  } else {
    for (const cand of blocked) {
      md += `### ${cand.scoreField} (${cand.splitMode}, ${cand.evidenceFilter})\n`;
      for (const failure of cand.failures) {
        md += `- ${failure}\n`;
      }
    }
  }
  md += `\n`;

  md += `## Required Data Improvements\n`;
  md += `- Acquire more raw L2 data.\n`;
  md += `- Increase temporally separated holdout size.\n`;
  md += `- Increase trade-print-backed evidence counts.\n\n`;

  md += `## Explicit Non-Claims\n`;
  md += `- This evaluation does not claim profitability.\n`;
  md += `- Live execution and risk gates have not been modified.\n`;

  writeFileSync(values["out-md"], md);
  console.log(`Wrote Markdown report to ${values["out-md"]}`);
}

console.log(`Global readiness decision: ${readiness.globalDecision}`);
