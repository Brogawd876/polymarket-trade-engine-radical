import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildPairedCaptureArgs,
  countPairManifests,
  inspectCaptureArtifacts,
  manifestIsCompleteAndValid,
} from "../../scripts/capture-corpus-utils.ts";
import type { PairManifest } from "../../engine/replay/pair-manifest.ts";

function makeManifest(slug: string, overrides: Partial<PairManifest> = {}): PairManifest {
  return {
    slug,
    replayLogPath: `logs/${slug}.log`,
    rawL2LogPath: `data/raw-l2/raw-l2-${slug}.ndjson`,
    strategy: "fair-value-maker",
    slotStartMs: 1,
    slotEndMs: 2,
    captureStartedAtMs: 1,
    captureEndedAtMs: 2,
    runtimeStartedAtMs: 1,
    runtimeEndedAtMs: 2,
    recorderStartedAtMs: 1,
    recorderEndedAtMs: 2,
    runtimeExitCode: 0,
    recorderExitCode: 0,
    recorderStopReason: "completed",
    recorderCompletedEventSeen: true,
    recorderSignal: null,
    replayEventCount: 2,
    rawL2EventCount: 2,
    rawL2BookEventCount: 1,
    rawL2TradeEventCount: 1,
    replayFirstEventTsMs: 2,
    replayLastEventTsMs: 3,
    rawL2FirstEventTsMs: 1,
    rawL2LastEventTsMs: 4,
    coverageLeadMs: 1,
    coverageTailMs: 1,
    parseErrors: [],
    validationErrors: [],
    validationWarnings: [],
    coverageVerdict: "complete",
    pairValidity: "valid",
    strategyLabStatus: "completed",
    strategyLabEvidenceVerdict: "usable",
    gitCommit: "test",
    commands: [],
    validatedAtMs: 1,
    createdAtMs: 1,
    ...overrides,
  };
}

describe("Capture corpus orchestration", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = path.join(os.tmpdir(), `capture-corpus-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("runs in dry-run mode without failing and writes summary", async () => {
    const outDir = path.join(tmpDir, "run");
    const pairsDir = path.join(tmpDir, "pairs");
    const invalidPairsDir = path.join(tmpDir, "rejected");
    const p = spawn("bun", [
      "scripts/capture-calibration-corpus.ts",
      "--dry-run",
      "--target-valid-pairs", "2",
      "--max-attempts", "2",
      "--out-dir", outDir,
      "--pairs-dir", pairsDir,
      "--invalid-pairs-dir", invalidPairsDir,
    ]);

    const promise = new Promise<{ code: number | null }>((resolve) => {
      p.on("close", (code) => resolve({ code }));
      p.on("error", () => resolve({ code: null }));
    });

    const { code } = await promise;
    expect(code).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(outDir, "corpus-summary.json"), "utf8"));
    expect(summary.attempts).toBe(2);
    expect(summary.validPairs).toBe(2);
  });

  test("paired capture args keep the configured relative slot offset stable", () => {
    const dirs = {
      pairsDir: "data/pairs-clean",
      rawL2Dir: "data/raw-l2-clean",
      invalidPairsDir: "data/pairs-rejected",
    };
    const first = buildPairedCaptureArgs({
      strategy: "fair-value-maker",
      rounds: "1",
      slotOffset: "1",
      strategyLabTimeoutMs: "180000",
      dirs,
    });
    const second = buildPairedCaptureArgs({
      strategy: "fair-value-maker",
      rounds: "1",
      slotOffset: "1",
      strategyLabTimeoutMs: "180000",
      dirs,
    });

    expect(first).toEqual(second);
    expect(first[first.indexOf("--slot-offset") + 1]).toBe("1");
    expect(first).toContain("--pairs-dir");
    expect(first).toContain("--raw-l2-dir");
    expect(first).toContain("--invalid-pairs-dir");
  });

  test("existing target artifacts are detected for skip protection", () => {
    const slug = "btc-updown-5m-100";
    const pairsDir = path.join(tmpDir, "skip-pairs");
    const rawL2Dir = path.join(tmpDir, "skip-raw");
    mkdirSync(pairsDir, { recursive: true });
    mkdirSync(rawL2Dir, { recursive: true });
    writeFileSync(path.join(pairsDir, `${slug}.pair.json`), JSON.stringify(makeManifest(slug)));

    const status = inspectCaptureArtifacts(slug, {
      pairsDir,
      rawL2Dir,
      invalidPairsDir: pairsDir,
    });

    expect(status.manifestExists).toBeTrue();
    expect(status.shouldSkip).toBeTrue();
    expect(inspectCaptureArtifacts(slug, {
      pairsDir,
      rawL2Dir,
      invalidPairsDir: pairsDir,
    }, true).shouldSkip).toBeFalse();
  });

  test("manifest counters keep valid and invalid outputs separate", () => {
    const pairsDir = path.join(tmpDir, "count-valid");
    const invalidPairsDir = path.join(tmpDir, "count-invalid");
    mkdirSync(pairsDir, { recursive: true });
    mkdirSync(invalidPairsDir, { recursive: true });
    writeFileSync(path.join(pairsDir, "valid.pair.json"), JSON.stringify(makeManifest("valid")));
    writeFileSync(path.join(invalidPairsDir, "invalid.pair.json"), JSON.stringify(makeManifest("invalid", {
      pairValidity: "invalid",
      coverageVerdict: "partial",
    })));

    const counts = countPairManifests(pairsDir, invalidPairsDir);
    expect(counts.validPairs).toBe(1);
    expect(counts.invalidPairs).toBe(1);
    expect(counts.totalPairs).toBe(2);
  });

  test("complete valid manifest is the only successful paired-capture result", () => {
    expect(manifestIsCompleteAndValid(makeManifest("valid"))).toBeTrue();
    expect(manifestIsCompleteAndValid(makeManifest("partial", {
      pairValidity: "invalid",
      coverageVerdict: "partial",
    }))).toBeFalse();
    expect(manifestIsCompleteAndValid(makeManifest("errored", {
      validationErrors: ["bad"],
    }))).toBeFalse();
  });
});
