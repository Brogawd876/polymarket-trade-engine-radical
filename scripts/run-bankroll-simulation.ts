/**
 * FVM Continuous Bankroll Simulation
 *
 * Runs 3 variants across 4 starting bankrolls with continuous bankroll tracking.
 * Computes ruin rate, drawdown, PnL per dollar exposed, and survival metrics.
 * 
 * Variants:
 *  - fvm-v1.1.0-raw-ungated (Champion baseline)
 *  - fvm-v1.2.1-hygienic-gated (Clamped + gated)
 *  - fvm-v1.3.0-profit-selective (Dynamic sizing + regime scaling + live falling-knife)
 *
 * Usage:
 *   npx tsx scripts/run-bankroll-simulation.ts [--pairs-dir data/pairs]
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import { type PairManifest } from "../engine/replay/pair-manifest.ts";
import { StrategyLabBatchManager } from "../engine/strategy-lab.ts";

// ── Configuration ─────────────────────────────────────────────────────────────

const VARIANTS = [
  "fvm-v1.1.0-raw-ungated",
  "fvm-v1.2.1-hygienic-gated",
  "fvm-v1.3.0-profit-selective"
];

const BANKROLLS = [5, 25, 50, 100];
const BATCH_SIZE = 15; // Smaller batch size to prevent OOM/timeouts during continuous runs

// ── Types ────────────────────────────────────────────────────────────────────

type VariantMetrics = {
  variantId: string;
  startBalance: number;
  terminalBalance: number;
  maxDrawdown: number;
  largestSingleRoundLoss: number;
  ruin: boolean;
  totalTurnover: number;
  totalSettlementPnl: number;
  wins: number;
  losses: number;
  tradeCount: number;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function usd(n: number) { return `$${n >= 0 ? "+" : ""}${n.toFixed(2)}`; }
function pct(n: number) { return `${(n * 100).toFixed(1)}%`; }

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let pairsDir = "data/pairs";
  let outMd = path.join("..", "..", "AI_WORKSPACE", "FVM_BANKROLL_SIMULATION.md");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pairs-dir") pairsDir = args[++i] || pairsDir;
    else if (args[i] === "--out-md") outMd = args[++i] || outMd;
  }

  if (!existsSync(pairsDir)) {
    console.error(`Pairs directory not found: ${pairsDir}`);
    process.exit(1);
  }

  const files = readdirSync(pairsDir).filter(f => f.endsWith(".pair.json"));
  const validManifests: PairManifest[] = [];
  for (const file of files) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(pairsDir, file), "utf-8")) as PairManifest;
      if (manifest.pairValidity === "valid") validManifests.push(manifest);
    } catch { /* skip */ }
  }

  // Sort manifests chronologically by slotStartMs so continuous bankroll plays out in order
  validManifests.sort((a, b) => a.slotStartMs - b.slotStartMs);

  console.log(`Loaded ${validManifests.length} valid pair manifests (chronological).`);
  if (validManifests.length === 0) process.exit(0);

  const chunks: PairManifest[][] = [];
  for (let i = 0; i < validManifests.length; i += BATCH_SIZE) {
    chunks.push(validManifests.slice(i, i + BATCH_SIZE));
  }

  const allMetrics: VariantMetrics[] = [];

  for (const startBal of BANKROLLS) {
    console.log(`\n======================================================`);
    console.log(`Starting Bankroll Level: $${startBal}`);
    console.log(`======================================================`);

    process.env.WALLET_BALANCE = String(startBal);

    // Create a fresh manager per bankroll level to reset the internal variantBalances state
    const manager = new StrategyLabBatchManager();

    // Track running state manually to compute drawdown and ruin
    const runningBalances: Record<string, number> = {};
    const peakBalances: Record<string, number> = {};
    const metrics: Record<string, VariantMetrics> = {};

    for (const v of VARIANTS) {
      runningBalances[v] = startBal;
      peakBalances[v] = startBal;
      metrics[v] = {
        variantId: v,
        startBalance: startBal,
        terminalBalance: startBal,
        maxDrawdown: 0,
        largestSingleRoundLoss: 0,
        ruin: false,
        totalTurnover: 0,
        totalSettlementPnl: 0,
        wins: 0,
        losses: 0,
        tradeCount: 0,
      };
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]!;
      const replayFiles = chunk.map(m => m.replayLogPath);
      const l2Files = Object.fromEntries(chunk.map(m => [m.replayLogPath, m.rawL2LogPath]));

      console.log(`\n  [Level $${startBal}] Batch ${ci + 1}/${chunks.length}: ${chunk.length} pairs...`);

      // Filter out variants that are already ruined
      const activeVariants = VARIANTS.filter(v => !metrics[v]!.ruin);
      
      if (activeVariants.length === 0) {
        console.log(`  All variants ruined. Skipping remaining batches.`);
        break;
      }

      let batch = await manager.createBatch({
        variants: activeVariants,
        files: replayFiles,
        l2Files,
        continuousBankroll: true,
      });

      const startMs = Date.now();
      while (batch.state === "queued" || batch.state === "running") {
        if (Date.now() - startMs > 300_000) {
          console.warn("    Batch timed out — using partial results.");
          manager.cancelBatch(batch.id);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
        batch = manager.getBatch(batch.id) ?? batch;
        process.stdout.write(`\r    ${batch.progress.completedRuns}/${batch.progress.totalRuns} runs...`);
      }
      console.log(`\n    Batch complete.`);

      // Process completed runs to update metrics
      for (const run of batch.runs) {
        if (run.status !== "completed") continue;
        const v = run.strategy; // Actually variantId
        const m = metrics[v];
        if (!m || m.ruin) continue;

        // Extract run PnL directly from the execution summary if available, fallback to run.pnl
        // Wait, run.pnl is the net pnl. But for true attribution we want to measure survival.
        // We will use run.pnl (which includes assumed 0 fees/slippage for now) as it's what strategy-lab computes.
        const pnl = run.pnl ?? 0;
        const turnover = run.execution?.turnover ?? 0;
        const fills = run.counts?.fills ?? 0;

        m.totalTurnover += turnover;
        m.totalSettlementPnl += pnl;
        m.tradeCount += fills;

        if (pnl > 0) m.wins++;
        else if (pnl < 0) m.losses++;

        if (pnl < m.largestSingleRoundLoss) m.largestSingleRoundLoss = pnl;

        runningBalances[v]! += pnl;
        m.terminalBalance = runningBalances[v]!;

        if (runningBalances[v]! > peakBalances[v]!) {
          peakBalances[v] = runningBalances[v]!;
        }

        const drawdown = peakBalances[v]! - runningBalances[v]!;
        if (drawdown > m.maxDrawdown) m.maxDrawdown = drawdown;

        if (runningBalances[v]! <= 0.05) {
          m.ruin = true;
          console.log(`    ⚠️ ${v} hit RUIN (balance: $${runningBalances[v]!.toFixed(2)})`);
        }
      }
    }

    for (const v of VARIANTS) {
      allMetrics.push(metrics[v]!);
      console.log(`  Result [${v}]: Balance=${usd(metrics[v]!.terminalBalance)}, DD=${usd(metrics[v]!.maxDrawdown)}, Ruin=${metrics[v]!.ruin}`);
    }
  }

  // ── Report Generation ────────────────────────────────────────────────────────
  
  const now = new Date().toISOString();
  const sections: string[] = [
    `# FVM Continuous Bankroll Simulation`,
    `\n_Generated: ${now}_`,
    `\n> **Objective:** Evaluate risk-adjusted returns and survival probability across multiple starting bankrolls.`,
    `> **Continuous Mode:** Balance carries forward chronologically. If balance ≤ 0, the variant is marked as ruined.`,
    `\n## Metrics Summary`,
  ];

  for (const startBal of BANKROLLS) {
    sections.push(`\n### Starting Bankroll: $${startBal}`);
    
    const header = `| Variant | Terminal Bal | Max DD | Worst Loss | Ruin | PnL / $ Exposed | Trades | WinRate |`;
    const sep =    `|---------|--------------|--------|------------|------|-----------------|--------|---------|`;
    
    const levelMetrics = allMetrics.filter(m => m.startBalance === startBal);
    
    const rows = levelMetrics.map(m => {
      const pnlPerDollar = m.totalTurnover > 0 ? m.totalSettlementPnl / m.totalTurnover : 0;
      const winRate = (m.wins + m.losses) > 0 ? m.wins / (m.wins + m.losses) : 0;
      const ruinStr = m.ruin ? "💥 YES" : "No";
      
      return `| ${m.variantId} | ${usd(m.terminalBalance)} | ${usd(m.maxDrawdown)} | ${usd(m.largestSingleRoundLoss)} | ${ruinStr} | ${pnlPerDollar >= 0 ? '+' : ''}${pnlPerDollar.toFixed(4)} | ${m.tradeCount} | ${pct(winRate)} |`;
    }).join("\n");

    sections.push(`${header}\n${sep}\n${rows}`);
  }

  const md = sections.join("\n");
  const outDir = path.dirname(outMd);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(outMd, md, "utf-8");
  console.log(`\nBankroll simulation complete: ${outMd}`);
}

main().catch(e => { console.error(e); process.exit(1); });
