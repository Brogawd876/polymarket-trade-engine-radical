import { parseArgs } from "util";
import { StrategyLabBatchManager, type StrategyLabBatch } from "../engine/strategy-lab.ts";
import { readdirSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import * as path from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "pairs-dir": { type: "string", default: "data/pairs" },
    "variants": { type: "string", multiple: true, default: ["fair-value-maker"] },
    "out-md": { type: "string", default: "data/reports/risk-mode-comparison.md" },
    "max-pairs": { type: "string", default: "5" },
    "continuous": { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: true,
});

async function main() {
  const manager = new StrategyLabBatchManager();
  const pairsDir = values["pairs-dir"] as string;
  const variants = values["variants"] as string[];
  const maxPairs = parseInt(values["max-pairs"] as string, 10);
  const continuous = values["continuous"] as boolean;

  const pairFiles = readdirSync(pairsDir)
    .filter(f => f.endsWith(".pair.json"))
    .slice(0, maxPairs);

  const files = pairFiles.map(f => {
    const manifest = JSON.parse(readFileSync(path.join(pairsDir, f), "utf8"));
    return manifest.replayLogPath;
  });

  const l2Files: Record<string, string> = {};
  for (const f of pairFiles) {
    const manifest = JSON.parse(readFileSync(path.join(pairsDir, f), "utf8"));
    l2Files[manifest.replayLogPath] = manifest.rawL2LogPath;
  }

  console.log(`Comparing normal vs permissive mode for ${variants.join(", ")} across ${files.length} pairs...`);

  // 1. Run Normal Mode
  const normalBatch = await manager.createBatch({
    variants,
    files,
    l2Files,
    riskMode: "normal",
    continuousBankroll: continuous,
  });

  // 2. Run Permissive Mode
  const permissiveBatch = await manager.createBatch({
    variants,
    files,
    l2Files,
    riskMode: "permissive-counterfactual",
    continuousBankroll: continuous,
  });

  // Poll for completion
  async function waitForBatch(batchId: string): Promise<StrategyLabBatch> {
    while (true) {
      const b = manager.getBatch(batchId);
      if (b?.state === "completed" || b?.state === "failed" || b?.state === "canceled") return b;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const [nResult, pResult] = await Promise.all([
    waitForBatch(normalBatch.id),
    waitForBatch(permissiveBatch.id),
  ]);

  const report = generateComparisonReport(nResult, pResult, continuous);
  if (!existsSync(path.dirname(values["out-md"] as string))) mkdirSync(path.dirname(values["out-md"] as string), { recursive: true });
  writeFileSync(values["out-md"] as string, report);

  console.log(`Comparison report written to ${values["out-md"]}`);
}

function generateComparisonReport(normal: StrategyLabBatch, permissive: StrategyLabBatch, isContinuous: boolean): string {
  let md = `# Risk Mode Comparison Audit\n\n`;
  md += `> **Warning:** Diagnostic-only replay report. Counterfactual mode allows trades that were blocked in reality. This is not proof of profitability.\n\n`;
  if (isContinuous) {
    md += `> **Note:** Continuous bankroll mode was active. Runs for a given variant were tracked chronologically with cumulative balances.\n\n`;
  }

  md += `## Summary\n\n`;
  md += `| Metric | Normal Mode | Permissive Mode | Delta |\n`;
  md += `| :--- | :---: | :---: | :---: |\n`;
  md += `| **Total PnL** | $${normal.summary.totalPnl.toFixed(2)} | $${permissive.summary.totalPnl.toFixed(2)} | $${(permissive.summary.totalPnl - normal.summary.totalPnl).toFixed(2)} |\n`;
  md += `| **Fills** | ${normal.runs.reduce((s, r) => s + r.counts.fills, 0)} | ${permissive.runs.reduce((s, r) => s + r.counts.fills, 0)} | ${permissive.runs.reduce((s, r) => s + r.counts.fills, 0) - normal.runs.reduce((s, r) => s + r.counts.fills, 0)} |\n`;
  md += `| **Blocked** | ${normal.summary.blocked} | ${permissive.summary.blocked} | ${permissive.summary.blocked - normal.summary.blocked} |\n`;

  md += `\n## Strategy Breakdown\n\n`;
  for (const nStrat of normal.summary.byStrategy) {
    const pStrat = permissive.summary.byStrategy.find(s => s.strategy === nStrat.strategy);
    if (!pStrat) continue;

    md += `### ${nStrat.label}\n`;
    md += `- **PnL:** $${nStrat.totalPnl.toFixed(2)} (Normal) vs $${pStrat.totalPnl.toFixed(2)} (Permissive)\n`;
    md += `- **Trade Count:** ${nStrat.tradeCount} vs ${pStrat.tradeCount}\n`;
    md += `- **Avg PnL/Run:** ${nStrat.avgPnl?.toFixed(2) ?? "N/A"} vs ${pStrat.avgPnl?.toFixed(2) ?? "N/A"}\n`;
    md += `- **Adverse Selection:** ${nStrat.conservativeFill.adverseSelectionRate?.toFixed(4) ?? "N/A"} vs ${pStrat.conservativeFill.adverseSelectionRate?.toFixed(4) ?? "N/A"}\n\n`;
  }

  return md;
}

main().catch(console.error);
