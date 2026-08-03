import { test, expect, describe } from "bun:test";
import { spawn } from "child_process";

describe("capture-paired-replay-l2 orchestrator", () => {
  test("Live/prod flags are rejected", async () => {
    const p = spawn("bun", ["scripts/capture-paired-replay-l2.ts", "--live"]);
    let err = "";
    p.stderr.on("data", b => err += b.toString());
    
    const exitCode = await new Promise(r => p.on("close", r));
    expect(exitCode).toBe(1);
    expect(err).toContain("Live/prod flags are forbidden");
  }, 15000);

  test("Raw L2 outlives the replay recorder and both tails are configurable", async () => {
    const file = Bun.file("scripts/capture-paired-replay-l2.ts");
    const text = await file.text();
    
    // Replay recording includes the configured post-slot tail.
    expect(text).not.toContain('"--duration-ms", "600000"');
    expect(text).toContain("const replayDurationMs =");
    expect(text).toContain("timeToSlotEnd + tailBufferMs");
    expect(text).toContain(
      '"--duration-ms", replayDurationMs.toString()',
    );
    
    // The raw recorder accounts for startup and stays alive after replay exits.
    expect(text).toContain("const recorderReadyTimeoutMs = 10000;");
    expect(text).toContain(
      "replayDurationMs + recorderReadyTimeoutMs + recorderSafetyBufferMs",
    );
    expect(text).toContain(
      '"--duration-ms", rawL2DurationMs.toString()',
    );
    
    // Defaults and CLI overrides retain the newer five-minute replay tail.
    expect(text).toContain("let tailBufferMs = 300000;");
    expect(text).toContain(
      'else if (arg === "--tail-buffer-ms") tailBufferMs = parseInt(args[++i] || "300000", 10);',
    );
    expect(text).toContain(
      'else if (arg === "--recorder-safety-buffer-ms") recorderSafetyBufferMs = parseInt(args[++i] || "10000", 10);',
    );
    
    // Replay exits, the raw-only safety tail elapses, then shutdown begins.
    const runtimeWaitIdx = text.indexOf('await runtime.promise;');
    const safetyTailWaitIdx = text.indexOf(
      "await new Promise(r => setTimeout(r, recorderSafetyBufferMs));",
    );
    const recorderStopIdx = text.indexOf('recorder.process.stdin?.write("stop\\n");');
    
    expect(runtimeWaitIdx).toBeGreaterThan(0);
    expect(safetyTailWaitIdx).toBeGreaterThan(runtimeWaitIdx);
    expect(recorderStopIdx).toBeGreaterThan(safetyTailWaitIdx);
  });
});
