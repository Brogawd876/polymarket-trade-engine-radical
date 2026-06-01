import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Corpus Runner Checkpointing and Resume", () => {
  let tmpDir: string;
  let reportsDir: string;
  let pairsDir: string;
  let pairManifestPath: string;
  let replayLogPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-runner-test-"));
    reportsDir = path.join(tmpDir, "reports");
    pairsDir = path.join(tmpDir, "pairs");
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.mkdirSync(pairsDir, { recursive: true });

    // Create a dummy valid pair manifest
    const pairManifest = {
      slug: "btc-updown-5m-dummy",
      marketAsset: "BTC",
      clobTokenIds: { "UP": "123", "DOWN": "456" },
      pairStartedAtMs: Date.now(),
      pairEndedAtMs: Date.now() + 1000,
      pairValidity: "valid",
      replayLogPath: path.join(tmpDir, "replay.log"),
      rawL2LogPath: path.join(tmpDir, "l2.log"),
    };

    // Minimal valid replay log: a single slot event and trade
    const replayLog = JSON.stringify({
      ts: Date.now(),
      type: "slot",
      action: "start",
      slug: "btc-updown-5m-dummy",
      startTime: Date.now(),
      endTime: Date.now() + 300000,
      strategy: "simulation"
    }) + "\n" + JSON.stringify({
      ts: Date.now() + 100,
      type: "market_trade",
      price: 0.5,
      shares: 10,
      side: "BUY",
      tokenId: "123"
    });

    pairManifestPath = path.join(pairsDir, "dummy.pair.json");
    replayLogPath = pairManifest.replayLogPath;
    
    fs.writeFileSync(pairManifestPath, JSON.stringify(pairManifest));
    fs.writeFileSync(replayLogPath, replayLog);
    fs.writeFileSync(pairManifest.rawL2LogPath, "");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runScript(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const proc = spawn("bun", ["scripts/run-strategy-lab-paired-corpus.ts", ...args], {
        cwd: process.cwd()
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
  }

  test("runs successfully and creates checkpoint, final and completeness JSON", async () => {
    const checkpointJsonl = path.join(reportsDir, "checkpoint.partial.jsonl");
    const outJson = path.join(reportsDir, "final.json");
    const completenessJson = path.join(reportsDir, "completeness.json");

    const { stdout, stderr, code } = await runScript([
      "--pairs-dir", pairsDir,
      "--checkpoint-jsonl", checkpointJsonl,
      "--out-json", outJson,
      "--completeness-json", completenessJson,
      "--variants", "simulation"
    ]);

    if (code !== 0) {
      console.error("STDOUT:", stdout);
      console.error("STDERR:", stderr);
    }
    expect(code).toBe(0);
    expect(fs.existsSync(checkpointJsonl)).toBe(true);
    expect(fs.existsSync(outJson)).toBe(true);
    expect(fs.existsSync(completenessJson)).toBe(true);

    const checkpointContent = fs.readFileSync(checkpointJsonl, "utf-8");
    const row = JSON.parse(checkpointContent.trim());
    
    // Validate identity metadata presence
    expect(row.gitCommit).toBeDefined();
    expect(row.variant).toBe("simulation");
    expect(row.pairId).toBe("btc-updown-5m-dummy");
    expect(row.strategyConfigHash).toBeDefined();
    expect(row.allowInferredFlow).toBe(false);
    expect(row.fillModel).toBe("conservative");
    expect(row.startedAt).toBeDefined();
    expect(row.finishedAt).toBeDefined();
    expect(row.status).toBe("completed");
    expect(row.metrics).toBeDefined();
  }, 120000);

  test("resume mode skips already completed runs", async () => {
    const checkpointJsonl = path.join(reportsDir, "checkpoint.partial.jsonl");
    const outJson = path.join(reportsDir, "final-resume.json");
    
    const { stdout, stderr, code } = await runScript([
      "--pairs-dir", pairsDir,
      "--checkpoint-jsonl", checkpointJsonl,
      "--out-json", outJson,
      "--variants", "simulation"
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Rows skipped on resume: 1");
  }, 120000);

  test("retry mode reruns stalled/failed rows only", async () => {
    const retryCheckpoint = path.join(reportsDir, "retry.partial.jsonl");
    const outJson = path.join(reportsDir, "final-retry.json");

    // Manually write a failed row to checkpoint
    const mockFailedRow = {
      gitCommit: "local",
      variant: "simulation",
      pairId: "btc-updown-5m-dummy",
      replayFile: replayLogPath,
      strategyConfigHash: "unknown",
      allowInferredFlow: false,
      fillModel: "conservative",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "failed",
      errorMessage: "Mock failure",
      metrics: {
        id: "mock-id",
        strategy: "simulation",
        baseStrategy: "simulation",
        variantLabel: "simulation",
        paperEligible: true,
        file: replayLogPath,
        slug: "btc-updown-5m-dummy",
        status: "failed",
        pnl: 0,
        direction: null,
        openPrice: null,
        closePrice: null,
        counts: {
          intents: 0,
          allowed: 0,
          blocked: 0,
          fills: 0,
          problems: 0,
          settlements: 0
        },
        verdict: "failed",
        brierScore: null,
        logLoss: null,
        execution: {
          fillRate: null,
          cancelRate: null,
          takerFeeSpend: 0,
          makerRebateEstimate: 0,
          grossEdgeCapture: null,
          turnover: 0,
          maxDrawdown: 0,
          markouts: {
            oneSecond: null,
            fiveSecond: null,
            thirtySecond: null,
            settlement: null,
            samples: 0,
            unavailableCount: 0,
            unavailableReasons: {}
          },
          conservativeFill: {
            conservativeFillEvidenceAvailable: false,
            conservativeFillEvidenceSource: "unavailable",
            conservativeFillVerdictCounts: {
              no_fill: 0,
              touch_only: 0,
              probable_fill: 0,
              trade_through_fill: 0,
              unknown_insufficient_data: 0
            },
            conservativeFillUnavailableReasons: {},
            conservativeMarkout1sAvg: null,
            conservativeMarkout5sAvg: null,
            conservativeMarkout30sAvg: null,
            conservativeAdverseSelectionRate: null,
            usableEvidenceCount: 0,
            evaluatedFillCount: 0,
            eligibleFillCount: 0,
            confirmedFillCount: 0,
            rejectedFillCount: 0,
            evidence: []
          }
        }
      }
    };
    
    try {
      const { execSync } = require("child_process");
      mockFailedRow.gitCommit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    } catch {}

    fs.writeFileSync(retryCheckpoint, JSON.stringify(mockFailedRow) + "\n");

    // Run without retry first - should skip
    const skipRes = await runScript([
      "--pairs-dir", pairsDir,
      "--checkpoint-jsonl", retryCheckpoint,
      "--out-json", outJson,
      "--variants", "simulation",
      "--force"
    ]);
    if (skipRes.code !== 0) {
      console.error("STDOUT:", skipRes.stdout);
      console.error("STDERR:", skipRes.stderr);
    }
    expect(skipRes.code).toBe(0);
    expect(skipRes.stdout).toContain("Rows skipped on resume: 1");

    // Run with retry mode - should rerun
    const retryRes = await runScript([
      "--pairs-dir", pairsDir,
      "--checkpoint-jsonl", retryCheckpoint,
      "--out-json", outJson,
      "--variants", "simulation",
      "--retry",
      "--force"
    ]);
    if (retryRes.code !== 0) {
      console.error("STDOUT:", retryRes.stdout);
      console.error("STDERR:", retryRes.stderr);
    }
    expect(retryRes.code).toBe(0);
    expect(retryRes.stdout).toContain("Stalled/failed rows classified & retried: 1");
  }, 120000);
});
