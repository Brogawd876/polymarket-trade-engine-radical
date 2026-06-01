import { parseArgs } from "util";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import type { CalibrationAuditSummary } from "../engine/replay/calibration-audit.ts";
import type { CalibrationGlobalReadiness } from "../engine/replay/calibration-readiness-gate.ts";
import { createCalibrationArtifactV1, hashCalibrationCorpus } from "../engine/replay/calibration-artifact.ts";

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    variant: { type: "string" },
    "audit-json": { type: "string" },
    "readiness-json": { type: "string" },
    "calibration-jsonl": { type: "string" },
    "out-dir": { type: "string", default: "data/calibration-models" },
    "created-at-ms": { type: "string" },
  },
  strict: true,
  allowPositionals: true,
});

const variant = values.variant;
const auditJson = values["audit-json"];
const readinessJson = values["readiness-json"];
const calibrationJsonl = values["calibration-jsonl"];

if (!variant || !auditJson || !readinessJson || !calibrationJsonl) {
  console.error("Usage: bun scripts/generate-calibration-artifact.ts --variant <variant> --audit-json <file> --readiness-json <file> --calibration-jsonl <file> [--out-dir <dir>]");
  process.exit(1);
}

const audit = JSON.parse(readFileSync(auditJson, "utf-8")) as CalibrationAuditSummary;
const readiness = JSON.parse(readFileSync(readinessJson, "utf-8")) as CalibrationGlobalReadiness;
const corpusContent = readFileSync(calibrationJsonl, "utf-8");
const artifact = createCalibrationArtifactV1({
  variant,
  audit,
  readiness,
  corpusHash: hashCalibrationCorpus(corpusContent),
  createdAtMs: values["created-at-ms"] ? parseInt(values["created-at-ms"], 10) : undefined,
});

if (!artifact) {
  console.error("No calibration artifact written: readiness did not produce a paper_candidate.");
  process.exit(2);
}

const safeVariant = variant.replace(/[^a-zA-Z0-9._-]/g, "_");
const outDir = path.join(values["out-dir"] as string, safeVariant);
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${artifact.createdAtMs}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2), "utf-8");
console.log(outPath);
