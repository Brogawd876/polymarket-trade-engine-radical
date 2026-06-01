import { parseArgs } from "util";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    "pairs-dir": { type: "string", default: "data/pairs" },
    "out-dir": { type: "string" },
    variant: { type: "string" },
    champion: { type: "string", default: "fvm-v3.1.0-avellaneda-momentum" },
    "calibrated-variant": { type: "string", default: "fvm-v5.1.0-avellaneda-isotonic" },
    "timeout-ms": { type: "string", default: "180000" },
    "batch-size": { type: "string", default: "6" },
  },
  strict: true,
  allowPositionals: true,
});

async function runProcess(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    console.log(`\n> ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });
}

function latestArtifactPath(root: string, variant: string): string | null {
  const dir = path.join(root, variant.replace(/[^a-zA-Z0-9._-]/g, "_"));
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  const latest = files.at(-1);
  return latest ? path.join(dir, latest) : null;
}

async function main(): Promise<void> {
  const outDir = values["out-dir"];
  const variant = values.variant;
  if (!outDir || !variant) {
    console.error("Usage: bun scripts/run-calibration-verification-pipeline.ts --variant <variant> --out-dir <dir> [--pairs-dir data/pairs]");
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const trainingDir = path.join(outDir, "training");
  const holdoutDir = path.join(outDir, "holdout");
  const artifactRoot = path.join(trainingDir, "calibration-models");

  const trainCode = await runProcess("bun", [
    "scripts/run-corpus-calibration-pipeline.ts",
    "--pairs-dir", values["pairs-dir"] as string,
    "--out-dir", trainingDir,
    "--strategy-lab-timeout-ms", values["timeout-ms"] as string,
    "--batch-size", values["batch-size"] as string,
    "--variants", variant,
  ]);
  if (trainCode !== 0) process.exit(trainCode ?? 1);

  const artifact = latestArtifactPath(artifactRoot, variant);
  if (!artifact) {
    console.error("No paper-candidate calibration artifact was produced; skipping calibrated holdout replay.");
    process.exit(2);
  }

  const holdoutCode = await runProcess("bun", [
    "scripts/run-strategy-lab-paired-corpus.ts",
    "--pairs-dir", values["pairs-dir"] as string,
    "--timeout-ms", values["timeout-ms"] as string,
    "--out-json", path.join(holdoutDir, "holdout-summary.json"),
    "--out-calibration-jsonl", path.join(holdoutDir, "holdout-calibration.jsonl"),
    "--variants", values.champion as string, values["calibrated-variant"] as string,
  ], {
    POLY_CALIBRATION_ARTIFACT_PATH: artifact,
    POLY_CALIBRATION_ARTIFACT_VARIANT: variant,
  });
  if (holdoutCode !== 0) process.exit(holdoutCode ?? 1);

  const summaryPath = path.join(holdoutDir, "holdout-summary.json");
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf-8")) : null;
  const reportPath = path.join(outDir, "verification-report.md");
  let md = "# Calibration Verification Report\n\n";
  md += `- Training variant: ${variant}\n`;
  md += `- Champion baseline: ${values.champion}\n`;
  md += `- Calibrated variant: ${values["calibrated-variant"]}\n`;
  md += `- Calibration artifact: ${artifact}\n\n`;
  md += "## Holdout Summary\n\n";
  md += "Promotion is manual only. Review PnL, drawdown, conservative fill quality, adverse selection, and trade count before paper use.\n\n";
  if (summary?.byStrategy) {
    for (const row of summary.byStrategy) {
      md += `- ${row.label}: PnL=$${row.totalPnl}, trades=${row.tradeCount}, adverseSelection=${row.conservativeFill?.adverseSelectionRate ?? "N/A"}\n`;
    }
  }
  writeFileSync(reportPath, md, "utf-8");
  console.log(`Verification report written to ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
