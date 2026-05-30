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
  });

  test("Recorder uses dynamic duration and tail buffer is configurable", async () => {
    const file = Bun.file("scripts/capture-paired-replay-l2.ts");
    const text = await file.text();
    
    // 1. Recorder command uses dynamic duration, not fixed 600000ms by default
    expect(text).not.toContain('"--duration-ms", "600000"');
    expect(text).toContain('const finalDurationMs = recorderDurationMs !== undefined');
    expect(text).toContain('timeToSlotEnd + 30000 + tailBufferMs + recorderSafetyBufferMs');
    expect(text).toContain('"--duration-ms", finalDurationMs.toString()');
    
    // 2. Post-runtime tail buffer default is at least 60000ms
    expect(text).toContain('let tailBufferMs = 60000;');
    
    // 3. CLI --tail-buffer-ms overrides the default
    expect(text).toContain('else if (arg === "--tail-buffer-ms") tailBufferMs = parseInt(args[++i] || "60000", 10);');
    
    // 4. Runtime exits before recorder shutdown is attempted
    const runtimeWaitIdx = text.indexOf('await runtime.promise;');
    const tailBufferWaitIdx = text.indexOf('await new Promise(r => setTimeout(r, tailBufferMs));');
    const recorderStopIdx = text.indexOf('recorder.process.stdin?.write("stop\\n");');
    
    expect(runtimeWaitIdx).toBeGreaterThan(0);
    expect(tailBufferWaitIdx).toBeGreaterThan(runtimeWaitIdx);
    expect(recorderStopIdx).toBeGreaterThan(tailBufferWaitIdx);
  });
});
