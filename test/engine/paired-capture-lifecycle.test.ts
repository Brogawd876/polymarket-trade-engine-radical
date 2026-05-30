import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { validatePair } from "../../engine/replay/pair-validator.ts";
import { StrategyLabBatchManager, type StrategyLabBatch } from "../../engine/strategy-lab.ts";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Pair Capture Lifecycle", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLogs(name: string, { includeCompleted = true } = {}) {
    const replayLog = path.join(tmpDir, `${name}-replay.log`);
    const l2Log = path.join(tmpDir, `${name}-l2.ndjson`);
    
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n");
    
    let l2Content = JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n";
    l2Content += JSON.stringify({ eventType: "market_trade", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n";
    if (includeCompleted) {
      l2Content += JSON.stringify({ eventType: "recorder_completed", ts: 5100 }) + "\n";
    }
    fs.writeFileSync(l2Log, l2Content);
    
    return { replayLog, l2Log };
  }

  test("zero exit code is always successful", async () => {
    const { replayLog, l2Log } = createLogs("zero-exit");
    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 },
      testStrategyLabVerdict: "usable"
    });
    
    expect(manifest.recorderStopReason).toBe("completed");
    expect(manifest.pairValidity).toBe("valid");
    expect(manifest.validationErrors.length).toBe(0);
  });

  test("null exit code with SIGINT and recorder_completed is successful", async () => {
    const { replayLog, l2Log } = createLogs("sigint-ok");
    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: null, recorderSignal: "SIGINT" },
      testStrategyLabVerdict: "usable"
    });
    
    expect(manifest.recorderStopReason).toBe("expected_sigint");
    expect(manifest.recorderCompletedEventSeen).toBe(true);
    expect(manifest.pairValidity).toBe("valid");
    expect(manifest.validationErrors.length).toBe(0);
  });

  test("null exit code with SIGINT but NO recorder_completed is a failure", async () => {
    const { replayLog, l2Log } = createLogs("sigint-fail", { includeCompleted: false });
    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: null, recorderSignal: "SIGINT" },
      testStrategyLabVerdict: "usable"
    });
    
    expect(manifest.recorderStopReason).toBe("unknown");
    expect(manifest.recorderCompletedEventSeen).toBe(false);
    expect(manifest.pairValidity).toBe("invalid");
    expect(manifest.validationErrors).toContain("Recorder exited via SIGINT but no recorder_completed event was seen.");
  });

  test("nonzero exit code is a failure", async () => {
    const { replayLog, l2Log } = createLogs("nonzero-exit");
    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 1 },
      testStrategyLabVerdict: "usable"
    });
    
    expect(manifest.recorderStopReason).toBe("crashed");
    expect(manifest.pairValidity).toBe("invalid");
    expect(manifest.validationErrors).toContain("Recorder crashed with exit code 1");
  });

  class MockBatchManager extends StrategyLabBatchManager {
    mockState: any = "completed";
    mockBatch: any = null;

    constructor(mockState: any, mockBatch: any) {
      super();
      this.mockState = mockState;
      this.mockBatch = mockBatch;
    }

    async createBatch(): Promise<any> {
      return { id: "mock-batch" };
    }

    getBatch(): any {
      return {
        id: "mock-batch",
        state: this.mockState,
        runs: this.mockBatch?.runs ?? [{ 
          status: "completed", 
          execution: { 
            conservativeFill: { 
              conservativeFillEvidenceAvailable: true,
              eligibleFillCount: 1,
              usableEvidenceCount: 1,
              conservativeFillUnavailableReasons: {}
            } 
          } 
        }]
      };
    }
  }

  test("strategy lab timeout does NOT invalidate structural pair", async () => {
    const { replayLog, l2Log } = createLogs("sl-timeout");
    
    // Use a manager that stays in "running" state to trigger timeout
    const mockManager = new MockBatchManager("running", null);

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 },
      strategyLabTimeoutMs: 50, // Fast timeout
      batchManager: mockManager
    });
    
    expect(manifest.strategyLabStatus).toBe("timed_out");
    expect(manifest.strategyLabError).toBe("Strategy Lab batch timed out during validation");
    expect(manifest.pairValidity).toBe("valid"); // Separated!
  });

  test("strategy lab failure does NOT invalidate structural pair", async () => {
    const { replayLog, l2Log } = createLogs("sl-failed");
    
    const mockManager = new MockBatchManager("failed", {
      runs: [{ status: "failed", error: "Injected failure" }]
    });

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 },
      batchManager: mockManager
    });
    
    expect(manifest.strategyLabStatus).toBe("failed");
    expect(manifest.strategyLabError).toBe("Injected failure");
    expect(manifest.pairValidity).toBe("valid");
  });

  test("valid strategy lab completion", async () => {
    const { replayLog, l2Log } = createLogs("sl-ok");
    
    const mockManager = new MockBatchManager("completed", null);

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 },
      batchManager: mockManager
    });
    
    if (manifest.strategyLabStatus === "failed") {
        console.log("Strategy Lab Error:", manifest.strategyLabError);
    }
    expect(manifest.strategyLabStatus).toBe("completed");
    expect(manifest.strategyLabEvidenceVerdict).toBe("usable");
    expect(manifest.pairValidity).toBe("valid");
  });
});
