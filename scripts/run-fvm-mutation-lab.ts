/**
 * FVM Mutation Lab POC
 *
 * Orchestrates a small deterministic replay, attribution, and AI-readable
 * recommendation pass. It does not change Strategy Lab simulation semantics.
 *
 * Usage:
 *   bun scripts/run-fvm-mutation-lab.ts --limit 12
 *   bun scripts/run-fvm-mutation-lab.ts --limit 12 --auto-apply best
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { spawn } from "child_process";
import type { PairManifest } from "../engine/replay/pair-manifest.ts";
import type { StrategyLabVariantSummary } from "../engine/strategy-lab.ts";
import { buildProfitSurface, renderProfitSurfaceMarkdown } from "./fvm-profit-surface.ts";
import type { FillAttributionRecord } from "./fvm-fill-attribution.ts";
import {
  compareChampionCandidate,
  createMutationLabManifest,
  generateMutationProposals,
  selectDeterministicPairs,
  type MutationLabManifest,
  type PairManifestSelection,
} from "./fvm-mutation-lab-core.ts";

type AutoApplyMode = "none" | "best";

type CliOptions = {
  pairsDir: string;
  outDir: string;
  runId: string;
  championVariant: string;
  candidateVariant: string;
  limit: number;
  balance: number;
  timeoutMs: number;
  autoApply: AutoApplyMode;
};

type CommandResult = {
  command: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

function parseArgs(args: string[]): CliOptions {
  const nowId = new Date().toISOString().replace(/[:.]/g, "-");
  const options: CliOptions = {
    pairsDir: "data/pairs",
    outDir: path.join("data", "reports", "mutation-lab"),
    runId: `fvm-mutlab-${nowId}`,
    championVariant: "fvm-v1.1.0-raw-ungated",
    candidateVariant: "fvm-v1.1.0-ai-mutant-poc",
    limit: 12,
    balance: 50,
    timeoutMs: 120_000,
    autoApply: "none",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pairs-dir") options.pairsDir = args[++i] || options.pairsDir;
    else if (arg === "--out-dir") options.outDir = args[++i] || options.outDir;
    else if (arg === "--run-id") options.runId = args[++i] || options.runId;
    else if (arg === "--champion") options.championVariant = args[++i] || options.championVariant;
    else if (arg === "--candidate") options.candidateVariant = args[++i] || options.candidateVariant;
    else if (arg === "--limit") {
      const parsed = parseInt(args[++i] || "", 10);
      if (Number.isFinite(parsed) && parsed > 0) options.limit = parsed;
    } else if (arg === "--balance") {
      const parsed = parseFloat(args[++i] || "");
      if (Number.isFinite(parsed) && parsed > 0) options.balance = parsed;
    } else if (arg === "--timeout-ms") {
      const parsed = parseInt(args[++i] || "", 10);
      if (Number.isFinite(parsed) && parsed > 0) options.timeoutMs = parsed;
    } else if (arg === "--auto-apply") {
      const parsed = args[++i];
      if (parsed === "best") options.autoApply = "best";
      else if (parsed === "none") options.autoApply = "none";
      else throw new Error(`Unsupported --auto-apply mode: ${parsed}`);
    }
  }

  return options;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readPairSelections(pairsDir: string): PairManifestSelection[] {
  if (!existsSync(pairsDir)) {
    throw new Error(`Pairs directory not found: ${pairsDir}`);
  }

  return readdirSync(pairsDir)
    .filter((file) => file.endsWith(".pair.json"))
    .sort()
    .flatMap((file) => {
      const manifestPath = path.join(pairsDir, file);
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PairManifest;
        return [{ path: manifestPath, manifest }];
      } catch {
        return [];
      }
    });
}

function copySelectedPairManifests(selected: PairManifestSelection[], selectedPairsDir: string): void {
  ensureDir(selectedPairsDir);
  for (let i = 0; i < selected.length; i++) {
    const manifest = selected[i]!.manifest;
    const slug = String(manifest.slug ?? `pair-${i}`).replace(/[^a-zA-Z0-9_.-]/g, "-");
    writeFileSync(path.join(selectedPairsDir, `${String(i).padStart(3, "0")}-${slug}.pair.json`), JSON.stringify(manifest, null, 2), "utf-8");
  }
}

function runCommand(command: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command[0]!, command.slice(1), { cwd });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    proc.on("close", (code) => {
      resolve({ command, cwd, exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeText(filePath: string, value: string): void {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, value, "utf-8");
}

function renderMutationBrief(input: {
  runId: string;
  championVariant: string;
  autoApply: AutoApplyMode;
  selectedPairCount: number;
  proposals: ReturnType<typeof generateMutationProposals>;
  profitSurfacePath: string;
}): string {
  const lines = [
    `# FVM Mutation Brief`,
    ``,
    `Run: \`${input.runId}\``,
    `Champion: \`${input.championVariant}\``,
    `Selected pairs: ${input.selectedPairCount}`,
    `Auto-apply mode: \`${input.autoApply}\``,
    `Profit surface: \`${input.profitSurfacePath}\``,
    ``,
    `## Ranked Proposals`,
  ];

  for (const proposal of input.proposals) {
    lines.push(
      ``,
      `### ${proposal.id}`,
      ``,
      `Hypothesis: ${proposal.hypothesis}`,
      ``,
      `Failure modes: ${proposal.failure_modes.join(", ")}`,
      ``,
      `Target behavior: ${proposal.target_behavior}`,
      ``,
      `Evidence:`,
      ...proposal.evidence.map((item) => `- ${item}`),
      ``,
      `Validation criteria:`,
      ...proposal.validation_criteria.map((item) => `- ${item}`),
      ``,
      `Rollback: ${proposal.rollback_plan}`,
    );
  }

  return lines.join("\n");
}

function renderDecisionSummary(input: {
  manifest: MutationLabManifest;
  comparison: unknown | null;
  proposalsPath: string;
}): string {
  return [
    `# Mutation Lab Decision Summary`,
    ``,
    `Run: \`${input.manifest.runId}\``,
    `Status: \`${input.manifest.status}\``,
    `Champion: \`${input.manifest.championVariant}\``,
    `Candidate: \`${input.manifest.candidateVariant ?? "not run"}\``,
    `Auto-apply: \`${input.manifest.autoApply}\``,
    `Selected pairs: ${input.manifest.selectedPairCount}`,
    ``,
    `The run produced AI-readable artifacts and stops here for human decision before merge, paper, or live use.`,
    ``,
    `Mutation proposals: \`${input.proposalsPath}\``,
    `Champion-vs-candidate comparison: ${input.comparison ? "`champion-vs-candidate.json`" : "`not run`"}`,
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const runDir = path.join(options.outDir, options.runId);
  const selectedPairsDir = path.join(runDir, "selected-pairs");
  ensureDir(runDir);

  const artifacts = {
    manifest: path.join(runDir, "manifest.json"),
    selectedPairs: path.join(runDir, "selected-pairs.json"),
    selectedPairsDir,
    strategyLabSummary: path.join(runDir, "strategy-lab-summary.json"),
    calibrationJsonl: path.join(runDir, "calibration.jsonl"),
    fillAttributionJsonl: path.join(runDir, "fill-attribution.jsonl"),
    profitSurfaceJson: path.join(runDir, "profit-surface.json"),
    profitSurfaceMd: path.join(runDir, "profit-surface.md"),
    mutationBrief: path.join(runDir, "mutation-brief.md"),
    mutationProposals: path.join(runDir, "mutation-proposals.json"),
    championVsCandidate: path.join(runDir, "champion-vs-candidate.json"),
    decisionSummary: path.join(runDir, "decision-summary.md"),
    commandTranscript: path.join(runDir, "command-transcript.json"),
  };

  const selected = selectDeterministicPairs(readPairSelections(options.pairsDir), options.limit);
  copySelectedPairManifests(selected, selectedPairsDir);
  writeJson(artifacts.selectedPairs, selected.map((entry) => ({
    sourcePath: entry.path,
    slug: entry.manifest.slug,
    replayLogPath: entry.manifest.replayLogPath,
    rawL2LogPath: entry.manifest.rawL2LogPath,
  })));

  let manifest = createMutationLabManifest({
    runId: options.runId,
    championVariant: options.championVariant,
    candidateVariant: options.autoApply === "best" ? options.candidateVariant : null,
    autoApply: options.autoApply,
    pairLimit: options.limit,
    selectedPairCount: selected.length,
    artifacts,
  });
  writeJson(artifacts.manifest, manifest);

  const commands: CommandResult[] = [];

  const strategyVariants = options.autoApply === "best"
    ? [options.championVariant, options.candidateVariant]
    : [options.championVariant];

  commands.push(await runCommand([
    "bun",
    "scripts/run-strategy-lab-paired-corpus.ts",
    "--pairs-dir",
    selectedPairsDir,
    "--timeout-ms",
    String(options.timeoutMs),
    "--allow-partial",
    "--out-json",
    artifacts.strategyLabSummary,
    "--out-calibration-jsonl",
    artifacts.calibrationJsonl,
    "--variants",
    ...strategyVariants,
  ], cwd));

  commands.push(await runCommand([
    "bun",
    "scripts/fvm-fill-attribution.ts",
    "--pairs-dir",
    selectedPairsDir,
    "--out-jsonl",
    artifacts.fillAttributionJsonl,
    "--balance",
    String(options.balance),
    "--variant",
    options.championVariant,
    "--limit",
    String(options.limit),
  ], cwd));

  const records = readJsonl<FillAttributionRecord>(artifacts.fillAttributionJsonl);
  const surface = buildProfitSurface(records, {
    variant: options.championVariant,
    inputJsonl: artifacts.fillAttributionJsonl,
  });
  writeJson(artifacts.profitSurfaceJson, surface);
  writeText(artifacts.profitSurfaceMd, renderProfitSurfaceMarkdown(surface));

  const proposals = generateMutationProposals(surface);
  writeJson(artifacts.mutationProposals, proposals);
  writeText(artifacts.mutationBrief, renderMutationBrief({
    runId: options.runId,
    championVariant: options.championVariant,
    autoApply: options.autoApply,
    selectedPairCount: selected.length,
    proposals,
    profitSurfacePath: artifacts.profitSurfaceJson,
  }));

  let comparison: unknown | null = null;
  if (options.autoApply === "best" && existsSync(artifacts.strategyLabSummary)) {
    const summary = JSON.parse(readFileSync(artifacts.strategyLabSummary, "utf-8")) as {
      summary?: { byStrategy?: StrategyLabVariantSummary[] };
    };
    comparison = compareChampionCandidate({
      championVariant: options.championVariant,
      candidateVariant: options.candidateVariant,
      summaries: summary.summary?.byStrategy ?? [],
    });
    writeJson(artifacts.championVsCandidate, comparison);
  }

  writeJson(artifacts.commandTranscript, commands);

  const failedCommands = commands.filter((command) => command.exitCode !== 0);
  manifest = {
    ...manifest,
    status: failedCommands.length > 0 ? "failed" : "completed",
    failures: failedCommands.map((command) => `${command.command.join(" ")} exited ${command.exitCode}`),
  };
  writeJson(artifacts.manifest, manifest);
  writeText(artifacts.decisionSummary, renderDecisionSummary({
    manifest,
    comparison,
    proposalsPath: artifacts.mutationProposals,
  }));

  if (failedCommands.length > 0) {
    process.exit(1);
  }

  console.log(`\nMutation lab artifacts written to ${runDir}`);
  console.log(`Decision summary: ${artifacts.decisionSummary}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
