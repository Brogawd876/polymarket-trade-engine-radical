import { test, expect } from "bun:test";
import { spawn } from "child_process";

test("Pipeline Runner > runs in dry-run mode without failing", async () => {
  const p = spawn("bun", [
    "scripts/run-corpus-calibration-pipeline.ts",
    "--dry-run",
    "--out-dir", "data/test-pipeline-runs"
  ]);

  const promise = new Promise<{ code: number | null }>((resolve) => {
    p.on("close", (code) => resolve({ code }));
    p.on("error", () => resolve({ code: null }));
  });

  const { code } = await promise;
  expect(code).toBe(0);
});

test("Pipeline Runner > fails cleanly when valid pairs are missing in non-dry-run mode", async () => {
  const p = spawn("bun", [
    "scripts/run-corpus-calibration-pipeline.ts",
    "--out-dir", "data/test-pipeline-runs",
    "--pairs-dir", "data/non_existent_pairs_dir"
  ]);

  const promise = new Promise<{ code: number | null }>((resolve) => {
    p.on("close", (code) => resolve({ code }));
    p.on("error", () => resolve({ code: null }));
  });

  const { code } = await promise;
  expect(code).toBe(1);
});
