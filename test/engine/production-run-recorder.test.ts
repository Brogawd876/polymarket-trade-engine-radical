import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunRecorder } from "../../engine/production/run-recorder.ts";

function envelope(source = "chainlink") {
  const payload = { answer: "10000000000000" };
  return {
    schemaVersion: 1,
    source,
    sourceSequence: "1",
    sourceTimestampMs: 100,
    ingestTimestampMs: 110,
    monotonicIngestNs: "1",
    originalPayloadHash: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
    payload,
  };
}

describe("immutable run recorder", () => {
  test("creates unique runs, fsyncs raw streams, and seals a hashed manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-recorder-"));
    try {
      const recorder = await RunRecorder.create({
        rootDirectory: root,
        runId: "run-1",
        gitCommit: "abc",
        dirtyWorktree: true,
        configHash: "config",
        modelHash: null,
        datasetVersion: "dataset-v1",
        eventSchemaVersion: 1,
        operatingMode: "shadow",
        processStartedAtMs: 1,
      });
      await recorder.record("chainlink", envelope());
      const manifest = await recorder.seal({
        endedAtMs: 200,
        requiredStreams: ["chainlink"],
      });
      expect(manifest.completenessVerdict).toBe("COMPLETE");
      expect(manifest.files["chainlink.ndjson"]?.sha256).toHaveLength(64);
      expect(
        existsSync(join(recorder.runDirectory, "manifest.json")),
      ).toBe(true);
      const parsed = JSON.parse(
        readFileSync(join(recorder.runDirectory, "manifest.json"), "utf8"),
      );
      expect(parsed.runId).toBe("run-1");
      await expect(recorder.record("chainlink", envelope())).rejects.toThrow(
        /sealed/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to append to an existing run identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-recorder-collision-"));
    try {
      await RunRecorder.create({
        rootDirectory: root,
        runId: "run-1",
        gitCommit: "abc",
        dirtyWorktree: false,
        configHash: "config",
        modelHash: null,
        datasetVersion: "dataset-v1",
        eventSchemaVersion: 1,
        operatingMode: "paper",
      });
      await expect(
        RunRecorder.create({
          rootDirectory: root,
          runId: "run-1",
          gitCommit: "abc",
          dirtyWorktree: false,
          configHash: "config",
          modelHash: null,
          datasetVersion: "dataset-v1",
          eventSchemaVersion: 1,
          operatingMode: "paper",
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marks a run incomplete when a required source is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-recorder-incomplete-"));
    try {
      const recorder = await RunRecorder.create({
        rootDirectory: root,
        runId: "run-1",
        gitCommit: "abc",
        dirtyWorktree: false,
        configHash: "config",
        modelHash: null,
        datasetVersion: "dataset-v1",
        eventSchemaVersion: 1,
        operatingMode: "shadow",
      });
      await recorder.record("chainlink", envelope());
      const manifest = await recorder.seal({
        requiredStreams: ["chainlink", "authenticated-user"],
      });
      expect(manifest.completenessVerdict).toBe("INCOMPLETE");
      expect(manifest.incompleteReasons.join(" ")).toContain(
        "authenticated-user",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("disk-full injection makes recorder health fatal and emits stop evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-recorder-disk-full-"));
    const fatalReasons: string[] = [];
    let recorder: RunRecorder | null = null;
    try {
      recorder = await RunRecorder.create({
        rootDirectory: root,
        runId: "run-disk-full",
        gitCommit: "abc",
        dirtyWorktree: false,
        configHash: "config",
        modelHash: null,
        datasetVersion: "dataset-v1",
        eventSchemaVersion: 1,
        operatingMode: "paper",
        onFatal: reason => fatalReasons.push(reason),
        faultInjection: {
          beforeRawWrite() {
            const error = new Error("ENOSPC: no space left on device");
            (error as NodeJS.ErrnoException).code = "ENOSPC";
            throw error;
          },
        },
      });

      await expect(
        recorder.record("authenticated-user", envelope("authenticated-user")),
      ).rejects.toThrow(/ENOSPC/);
      expect(recorder.health().writable).toBe(false);
      expect(recorder.health().failureReason).toContain("write failed");
      expect(fatalReasons).toHaveLength(1);
      expect(fatalReasons[0]).toContain("ENOSPC");
      await expect(
        recorder.record("authenticated-user", envelope("authenticated-user")),
      ).rejects.toThrow(/run recorder failed/);
    } finally {
      await recorder?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
