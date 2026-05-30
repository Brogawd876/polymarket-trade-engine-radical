import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Corpus Runner (run-strategy-lab-paired-corpus.ts)", () => {
  let tmpDir: string;
  let reportsDir: string;
  let pairsDir: string;

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

    // Minimal valid replay log: a single slot event
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

    fs.writeFileSync(path.join(pairsDir, "dummy.pair.json"), JSON.stringify(pairManifest));
    fs.writeFileSync(pairManifest.replayLogPath, replayLog);
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

  test("runs successfully on valid corpus without timeout", async () => {
    const outJson = path.join(reportsDir, "ok-summary.json");
    const { stdout, stderr, code } = await runScript([
      "--pairs-dir", pairsDir,
      "--out-json", outJson,
      "--variants", "simulation"
    ]);
    
    if (code !== 0) {
      console.error("STDOUT:", stdout);
      console.error("STDERR:", stderr);
    }
    expect(code).toBe(0);
    expect(stdout).toContain("Strategy Lab Batch Completed. State: completed");
    expect(fs.existsSync(outJson)).toBe(true);
  }, 120000);

  test("completes repeated sequential runs on a valid corpus", async () => {
    for (let i = 1; i <= 2; i++) {
      const outJson = path.join(reportsDir, `repeat-${i}-summary.json`);
      const { stdout, stderr, code } = await runScript([
        "--pairs-dir", pairsDir,
        "--out-json", outJson,
        "--variants", "simulation"
      ]);

      if (code !== 0) {
        console.error("STDOUT:", stdout);
        console.error("STDERR:", stderr);
      }
      expect(code).toBe(0);
      expect(stdout).toContain("Strategy Lab Batch Completed. State: completed");
      expect(fs.existsSync(outJson)).toBe(true);
    }
  }, 120000);

  test("timeout with incomplete runs returns non-zero code and marked as timed_out", async () => {
    // To make it time out before completion, we'll override Date.now() to jump ahead
    const wrapperScript = path.join(__dirname, ".tmp-timeout-runner.ts");
    const wrapperContent = `
const originalDateNow = Date.now;
let count = 0;
Date.now = () => {
  count++;
  if (count > 2) return originalDateNow() + 200000; // Jump 200s ahead!
  return originalDateNow();
};
import "../../scripts/run-strategy-lab-paired-corpus.ts";
`;
    fs.writeFileSync(wrapperScript, wrapperContent);
    const outJson = path.join(reportsDir, "timeout-summary.json");
    
    const { stdout, code } = await new Promise<{stdout: string, code: number}>((resolve) => {
      const proc = spawn("bun", [wrapperScript, "--pairs-dir", pairsDir, "--out-json", outJson, "--variants", "simulation", "--timeout-ms", "120000"], { cwd: process.cwd() });
      let out = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.on("close", (c) => resolve({ stdout: out, code: c ?? 1 }));
    });
    
    fs.rmSync(wrapperScript, { force: true });
    
    expect(code).not.toBe(0); // Should fail
    expect(stdout).toContain("[ERROR] Strategy Lab Batch Timed Out!");
    expect(stdout).toContain("Status: timed_out");
    expect(fs.existsSync(outJson)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(outJson, "utf8"));
    expect(summary.status).toBe("timed_out");
  }, 120000);
  
  test("graceful failure when allowing partials", async () => {
    const wrapperScript = path.join(__dirname, ".tmp-timeout-partial-runner.ts");
    const wrapperContent = `
const originalDateNow = Date.now;
let count = 0;
Date.now = () => {
  count++;
  if (count > 2) return originalDateNow() + 200000; // Jump 200s ahead!
  return originalDateNow();
};
import "../../scripts/run-strategy-lab-paired-corpus.ts";
`;
    fs.writeFileSync(wrapperScript, wrapperContent);
    
    const { stdout, code } = await new Promise<{stdout: string, code: number}>((resolve) => {
      const proc = spawn("bun", [wrapperScript, "--pairs-dir", pairsDir, "--allow-partial", "--variants", "simulation", "--timeout-ms", "120000"], { cwd: process.cwd() });
      let out = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.on("close", (c) => resolve({ stdout: out, code: c ?? 1 }));
    });
    fs.rmSync(wrapperScript, { force: true });
    
    expect(code).toBe(0); // allow-partial makes exit code 0
    expect(stdout).toContain("Status: timed_out");
  }, 120000);

  test("handles internal state mismatch properly (mocked)", async () => {
    // We create a wrapper script that mocks the StrategyLabBatchManager
    // to simulate the case where all runs complete but state remains "running".
    const wrapperScript = path.join(__dirname, ".tmp-mock-runner.ts");
    const wrapperContent = `
import { StrategyLabBatchManager } from "../../engine/strategy-lab.ts";
const originalGetBatch = StrategyLabBatchManager.prototype.getBatch;
StrategyLabBatchManager.prototype.getBatch = function(id) {
  const batch = originalGetBatch.call(this, id);
  if (batch && batch.progress.completedRuns === batch.progress.totalRuns && batch.progress.totalRuns > 0) {
    batch.state = "running"; // Force the mismatched state!
  }
  return batch;
};
import "../../scripts/run-strategy-lab-paired-corpus.ts";
`;
    fs.writeFileSync(wrapperScript, wrapperContent);

    const outJson = path.join(reportsDir, "mismatch-summary.json");
    const proc = spawn("bun", [wrapperScript, "--pairs-dir", pairsDir, "--out-json", outJson, "--variants", "simulation", "--timeout-ms", "2000"], {
      cwd: process.cwd()
    });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    
    const code = await new Promise(r => proc.on("close", r));
    fs.rmSync(wrapperScript, { force: true });
    
    expect(code).toBe(1); // Should fail because of internal state mismatch
    expect(stdout).toContain("Strategy Lab Batch internal state mismatch!");
    expect(fs.existsSync(outJson)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(outJson, "utf8"));
    expect(summary.status).toBe("internal_state_mismatch");
  }, 120000);
});
