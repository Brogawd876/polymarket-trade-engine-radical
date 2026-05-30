import { spawn, type ChildProcess } from "child_process";
import { getSlug, getSlotTS } from "../utils/slot.ts";
import { validatePair } from "../engine/replay/pair-validator.ts";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import * as path from "path";
import { gitCommitFromEnv } from "../engine/event-store/events.ts";
import {
  manifestIsCompleteAndValid,
  pairManifestPath,
  rawL2LogPath as makeRawL2LogPath,
  replayLogPath as makeReplayLogPath,
} from "./capture-corpus-utils.ts";

function execProcess(
  cmd: string, 
  args: string[], 
  onStdout?: (data: string) => void,
  onStderr?: (data: string) => void
): { process: ChildProcess; promise: Promise<{ code: number | null; signal: string | null }> } {
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }); // Enable stdin
  const promise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    p.stdout.on("data", (b) => {
      const s = b.toString();
      if (onStdout) onStdout(s);
      else process.stdout.write(s);
    });
    p.stderr.on("data", (b) => {
      const s = b.toString();
      if (onStderr) onStderr(s);
      else process.stderr.write(s);
    });
    p.on("close", (code, signal) => resolve({ code, signal }));
    p.on("error", () => resolve({ code: null, signal: null }));
  });
  return { process: p, promise };
}

async function main() {
  const args = process.argv.slice(2);
  let strategy = "late-entry";
  let rounds = 1;
  let slotOffset = 1;
  let strategyLabTimeoutMs = 120000;
  let pairsDir = path.join("data", "pairs");
  let rawL2Dir = path.join("data", "raw-l2");
  let invalidPairsDir: string | null = null;
  let tailBufferMs = 60000;
  let recorderDurationMs: number | undefined;
  let recorderSafetyBufferMs = 10000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--strategy") strategy = args[++i] || strategy;
    else if (arg === "--rounds") rounds = parseInt(args[++i] || "1", 10);
    else if (arg === "--slot-offset") slotOffset = parseInt(args[++i] || "1", 10);
    else if (arg === "--strategy-lab-timeout-ms") strategyLabTimeoutMs = parseInt(args[++i] || "120000", 10);
    else if (arg === "--pairs-dir") pairsDir = args[++i] || pairsDir;
    else if (arg === "--raw-l2-dir") rawL2Dir = args[++i] || rawL2Dir;
    else if (arg === "--invalid-pairs-dir") invalidPairsDir = args[++i] || invalidPairsDir;
    else if (arg === "--tail-buffer-ms") tailBufferMs = parseInt(args[++i] || "60000", 10);
    else if (arg === "--recorder-duration-ms") recorderDurationMs = parseInt(args[++i] || "0", 10);
    else if (arg === "--recorder-safety-buffer-ms") recorderSafetyBufferMs = parseInt(args[++i] || "10000", 10);
    else if (arg === "--prod" || arg === "--live") {
      console.error("Live/prod flags are forbidden in this capture script.");
      process.exit(1);
    }
  }

  if (process.env.POLY_PROD === "true" || process.env.LIVE_TRADING === "true") {
    console.error("Live/prod environment variables are forbidden in this capture script.");
    process.exit(1);
  }

  const slug = getSlug(slotOffset);
  const slot = getSlotTS(slotOffset);
  
  console.log(`[Orchestrator] Resolved target slug: ${slug}`);
  console.log(`[Orchestrator] Slot window: ${new Date(slot.startTime).toISOString()} to ${new Date(slot.endTime).toISOString()}`);

  if (!existsSync(rawL2Dir)) mkdirSync(rawL2Dir, { recursive: true });
  if (!existsSync(pairsDir)) mkdirSync(pairsDir, { recursive: true });
  const rejectedPairsDir = invalidPairsDir ?? pairsDir;
  if (!existsSync(rejectedPairsDir)) mkdirSync(rejectedPairsDir, { recursive: true });

  const replayLogPath = makeReplayLogPath(slug);
  const rawL2LogPath = makeRawL2LogPath(rawL2Dir, slug);

  const captureStartedAtMs = Date.now();

  const timeToSlotEnd = Math.max(0, slot.endTime - Date.now());
  const finalDurationMs = recorderDurationMs !== undefined 
    ? recorderDurationMs 
    : timeToSlotEnd + 30000 + tailBufferMs + recorderSafetyBufferMs;

  console.log(`[Orchestrator] Starting Raw L2 Recorder (saving to ${rawL2LogPath}, duration ${finalDurationMs}ms)...`);
  const recorderStartedAtMs = Date.now();
  let recorderReady = false;
  
  const recorderCmd = ["bun", "scripts/record-raw-l2.ts", "--slug", slug, "--out", rawL2LogPath, "--duration-ms", finalDurationMs.toString()];
  const recorder = execProcess(recorderCmd[0]!, recorderCmd.slice(1), (data) => {
    process.stdout.write(`[Recorder] ${data}`);
    if (data.includes("Recorder is running")) {
      recorderReady = true;
    }
  }, (data) => process.stderr.write(`[Recorder ERR] ${data}`));

  let waitAttempts = 0;
  while (!recorderReady && waitAttempts < 100) {
    await new Promise(r => setTimeout(r, 100));
    waitAttempts++;
  }

  if (!recorderReady) {
    console.error(`[Orchestrator] Recorder failed to become ready within 10 seconds. Aborting.`);
    recorder.process.kill("SIGINT");
    process.exit(1);
  }

  console.log(`[Orchestrator] Recorder ready. Starting bot runtime...`);
  const runtimeStartedAtMs = Date.now();
  const runtimeCmd = ["bun", "index.ts", "--strategy", strategy, "--rounds", rounds.toString(), "--slot-offset", slotOffset.toString(), "--always-log"];
  const runtime = execProcess(runtimeCmd[0]!, runtimeCmd.slice(1), (data) => {
    process.stdout.write(`[Bot] ${data}`);
  }, (data) => process.stderr.write(`[Bot ERR] ${data}`));

  const { code: runtimeExitCode } = await runtime.promise;
  const runtimeEndedAtMs = Date.now();
  console.log(`[Orchestrator] Bot runtime exited with code ${runtimeExitCode}`);

  console.log(`[Orchestrator] Waiting ${tailBufferMs}ms for L2 tail buffer...`);
  await new Promise(r => setTimeout(r, tailBufferMs));

  console.log(`[Orchestrator] Attempting clean recorder shutdown via stdin...`);
  recorder.process.stdin?.write("stop\n");
  
  // Give it 3 seconds to stop cleanly via stdin
  let recorderDone = false;
  const timeout = setTimeout(() => {
    if (!recorderDone) {
      console.log(`[Orchestrator] Recorder clean shutdown timed out. Sending SIGINT...`);
      recorder.process.kill("SIGINT");
    }
  }, 3000);

  const { code: recorderExitCode, signal: recorderSignal } = await recorder.promise;
  recorderDone = true;
  clearTimeout(timeout);

  const recorderEndedAtMs = Date.now();
  console.log(`[Orchestrator] Recorder exited with code ${recorderExitCode}, signal ${recorderSignal}`);
  const captureEndedAtMs = Date.now();

  console.log(`[Orchestrator] Capture complete. Running validation...`);

  const manifest = await validatePair(slug, replayLogPath, rawL2LogPath, strategy, {
    strategyLabTimeoutMs,
    metadata: {
      slotStartMs: slot.startTime,
      slotEndMs: slot.endTime,
      captureStartedAtMs,
      captureEndedAtMs,
      runtimeStartedAtMs,
      runtimeEndedAtMs,
      recorderStartedAtMs,
      recorderEndedAtMs,
      runtimeExitCode,
      recorderExitCode,
      recorderSignal,
      gitCommit: gitCommitFromEnv(),
      commands: [
        recorderCmd.join(" "),
        runtimeCmd.join(" "),
      ]
    }
  });

  if (runtimeExitCode !== 0) {
    manifest.validationErrors.push(`Runtime process failed with code ${runtimeExitCode}`);
  }
  
  // Recorder failure check is now handled inside validatePair using SIGINT logic

  const manifestValid = manifestIsCompleteAndValid(manifest);
  const manifestPath = pairManifestPath(
    manifestValid ? pairsDir : rejectedPairsDir,
    slug,
  );
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (!manifestValid) {
    console.error(`[Orchestrator] Validation failed.`);
    if (manifest.validationErrors.length > 0) {
      console.error(`[Orchestrator] Validation errors:`, manifest.validationErrors);
    }
    if (manifest.parseErrors.length > 0) {
      console.error(`[Orchestrator] Parse errors:`, manifest.parseErrors);
    }
    console.error(`[Orchestrator] Pair validity: ${manifest.pairValidity}`);
    console.error(`[Orchestrator] Coverage: ${manifest.coverageVerdict}`);
    console.log(`[Orchestrator] Manifest written to: ${manifestPath}`);
    process.exit(1);
  } else {
    console.log(`[Orchestrator] Validation passed!`);
    console.log(`[Orchestrator] Coverage: ${manifest.coverageVerdict}`);
    console.log(`[Orchestrator] Strategy Lab Status: ${manifest.strategyLabStatus}`);
    console.log(`[Orchestrator] Strategy Lab Evidence Verdict: ${manifest.strategyLabEvidenceVerdict}`);
    console.log(`[Orchestrator] Manifest written to: ${manifestPath}`);
  }
}

main().catch(console.error);
