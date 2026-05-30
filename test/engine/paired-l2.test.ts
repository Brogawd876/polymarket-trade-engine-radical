import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { validatePair } from "../../engine/replay/pair-validator.ts";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Pair Validator", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pair-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("missing files yield validation errors and missing coverage", async () => {
    const manifest = await validatePair("btc-updown-5m-100", path.join(tmpDir, "missing.log"), path.join(tmpDir, "missing.ndjson"), "late-entry");
    
    expect(manifest.validationErrors).toContain(`Replay log not found: ${path.join(tmpDir, "missing.log")}`);
    expect(manifest.validationErrors).toContain(`Raw L2 log not found: ${path.join(tmpDir, "missing.ndjson")}`);
    expect(manifest.coverageVerdict).toBe("missing");
    expect(manifest.strategyLabEvidenceVerdict).toBe("failed");
    expect(manifest.pairValidity).toBe("invalid");
  });

  test("empty files yield validation errors", async () => {
    const emptyLog = path.join(tmpDir, "empty.log");
    const emptyNdjson = path.join(tmpDir, "empty.ndjson");
    fs.writeFileSync(emptyLog, "");
    fs.writeFileSync(emptyNdjson, "");

    const manifest = await validatePair("btc-updown-5m-100", emptyLog, emptyNdjson, "late-entry");
    
    expect(manifest.validationErrors).toContain("Replay log is empty");
    expect(manifest.validationErrors).toContain("Raw L2 log is empty");
    expect(manifest.coverageVerdict).toBe("missing");
    expect(manifest.pairValidity).toBe("invalid");
  });

  test("malformed replay NDJSON fails", async () => {
    const replayLog = path.join(tmpDir, "malformed.log");
    const l2Log = path.join(tmpDir, "malformed-ok.ndjson");
    fs.writeFileSync(replayLog, "this is not json\n");
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 2000 }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry");
    
    expect(manifest.parseErrors.length).toBeGreaterThan(0);
    expect(manifest.parseErrors[0]).toContain("Failed to parse replay event");
    expect(manifest.pairValidity).toBe("invalid");
  });

  test("malformed raw L2 NDJSON fails", async () => {
    const replayLog = path.join(tmpDir, "malformed-ok2.log");
    const l2Log = path.join(tmpDir, "malformed2.ndjson");
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 1000 }) + "\n");
    fs.writeFileSync(l2Log, "not json either\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry");
    
    expect(manifest.parseErrors.length).toBeGreaterThan(0);
    expect(manifest.parseErrors[0]).toContain("Failed to parse raw L2 event");
    expect(manifest.pairValidity).toBe("invalid");
  });

  test("slug mismatch fails", async () => {
    const replayLog = path.join(tmpDir, "slugmismatch.log");
    const l2Log = path.join(tmpDir, "slugmismatch.ndjson");
    
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 1000, slug: "wrong-slug" }) + "\n" + JSON.stringify({ ts: 5000, slug: "wrong-slug" }) + "\n");
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 500, slug: "wrong-slug-2" }) + "\n" + JSON.stringify({ eventType: "market_trade", receivedTsMs: 6000 }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry");
    
    expect(manifest.validationErrors.some(e => e.includes("Replay log slug mismatch: expected btc-updown-5m-100, found wrong-slug"))).toBeTrue();
    expect(manifest.validationErrors.some(e => e.includes("Raw L2 log slug mismatch: expected btc-updown-5m-100, found wrong-slug-2"))).toBeTrue();
    expect(manifest.pairValidity).toBe("invalid");
  });

  test("zero useful raw L2 events fails", async () => {
    const replayLog = path.join(tmpDir, "zerouseful.log");
    const l2Log = path.join(tmpDir, "zerouseful.ndjson");
    
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 1000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 5000, slug: "btc-updown-5m-100" }) + "\n");
    // Only raw_market_message
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "raw_market_message", receivedTsMs: 500, slug: "btc-updown-5m-100" }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry");
    
    expect(manifest.validationErrors).toContain("Raw L2 log contains zero useful book or trade events.");
    expect(manifest.pairValidity).toBe("invalid");
  });

  test("partial coverage detected", async () => {
    const replayLog = path.join(tmpDir, "partial.log");
    const l2Log = path.join(tmpDir, "partial.ndjson");
    
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 1000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 5000, slug: "btc-updown-5m-100" }) + "\n");
    // L2 starts late and ends early
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ eventType: "market_trade", receivedTsMs: 4000, slug: "btc-updown-5m-100" }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry");
    
    expect(manifest.coverageVerdict).toBe("partial");
    expect(manifest.coverageLeadMs).toBe(1000 - 2000); // -1000
    expect(manifest.coverageTailMs).toBe(4000 - 5000); // -1000
    expect(manifest.pairValidity).toBe("invalid");
  });

  test("complete coverage works with out-of-order lines", async () => {
    const replayLog = path.join(tmpDir, "complete.log");
    const l2Log = path.join(tmpDir, "complete.ndjson");
    
    // Out of order: 4000 then 2000
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n");
    // Out of order: 5000 then 1000
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_trade", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 }
    });
    
    expect(manifest.coverageVerdict).toBe("complete");
    expect(manifest.coverageLeadMs).toBe(2000 - 1000); // 1000
    expect(manifest.coverageTailMs).toBe(5000 - 4000); // 1000
    // Should be valid now if metadata provided and SL skipped (or mocked)
    expect(manifest.pairValidity).toBe("valid");
  });

  test("valid pair manifest (complete + usable)", async () => {
    const replayLog = path.join(tmpDir, "complete2.log");
    const l2Log = path.join(tmpDir, "complete2.ndjson");
    
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n");
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ eventType: "market_trade", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 },
      testStrategyLabVerdict: "usable"
    });
    
    expect(manifest.coverageVerdict).toBe("complete");
    expect(manifest.pairValidity).toBe("valid");
    expect(manifest.strategyLabEvidenceVerdict).toBe("usable");
  });

  test("valid pair manifest (complete + insufficient data)", async () => {
    const replayLog = path.join(tmpDir, "complete_insufficient.log");
    const l2Log = path.join(tmpDir, "complete_insufficient.ndjson");
    
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n");
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ eventType: "market_trade", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 },
      testStrategyLabVerdict: "unavailable_insufficient_data"
    });
    
    expect(manifest.coverageVerdict).toBe("complete");
    expect(manifest.pairValidity).toBe("valid");
    expect(manifest.strategyLabEvidenceVerdict).toBe("unavailable_insufficient_data");
  });

  test("valid pair manifest (complete + no fills)", async () => {
    const replayLog = path.join(tmpDir, "complete3.log");
    const l2Log = path.join(tmpDir, "complete3.ndjson");
    
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n");
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ eventType: "market_trade", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 },
      testStrategyLabVerdict: "unavailable_no_fills"
    });
    
    expect(manifest.coverageVerdict).toBe("complete");
    expect(manifest.pairValidity).toBe("valid");
    expect(manifest.strategyLabEvidenceVerdict).toBe("unavailable_no_fills");
  });

  test("invalid pair manifest (complete + injected failure)", async () => {
    const replayLog = path.join(tmpDir, "complete4.log");
    const l2Log = path.join(tmpDir, "complete4.ndjson");
    
    fs.writeFileSync(replayLog, JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n");
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ eventType: "market_trade", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 },
      testStrategyLabError: "Simulated SL crash"
    });
    
    expect(manifest.coverageVerdict).toBe("complete");
    expect(manifest.strategyLabStatus).toBe("failed");
    expect(manifest.strategyLabError).toBe("Simulated SL crash");
    expect(manifest.pairValidity).toBe("valid");
  });


  // Phase 8U: Capture Quality Hardening Tests

  test("zero trade events (book-only) produces warning but not error", async () => {
    const replayLog = path.join(tmpDir, "bookonly.log");
    const l2Log = path.join(tmpDir, "bookonly.ndjson");

    fs.writeFileSync(replayLog, JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n");
    // Only book events, no trade events
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ eventType: "market_book_delta", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: 0 },
    });

    expect(manifest.rawL2TradeEventCount).toBe(0);
    expect(manifest.rawL2BookEventCount).toBeGreaterThan(0);
    // Should be a warning, not an error
    expect(manifest.validationWarnings.some(w => w.includes("zero trade events"))).toBeTrue();
    expect(manifest.validationErrors.some(e => e.includes("zero trade events"))).toBeFalse();
    // Coverage can still be complete
    expect(manifest.coverageVerdict).toBe("complete");
    // Pair is still valid (book-only is a warning not a blocker)
    expect(manifest.pairValidity).toBe("valid");
  });

  test("recorder stop reason unknown produces warning", async () => {
    const replayLog = path.join(tmpDir, "unknownstop.log");
    const l2Log = path.join(tmpDir, "unknownstop.ndjson");

    fs.writeFileSync(replayLog, JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n");
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ eventType: "market_trade", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n");

    // No recorderExitCode, no signal = unknown stop reason from metadata
    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: null, recorderSignal: null, recorderStopReason: "unknown" },
    });

    expect(manifest.recorderStopReason).toBe("unknown");
    expect(manifest.validationWarnings.some(w => w.includes("Recorder stop reason is unknown"))).toBeTrue();
    // Unknown stop reason alone is a warning, not an error
    expect(manifest.validationErrors.some(e => e.includes("stop reason"))).toBeFalse();
    // Pair is still valid if coverage is complete
    expect(manifest.pairValidity).toBe("valid");
  });

  test("recorder SIGINT without recorder_completed event produces error", async () => {
    const replayLog = path.join(tmpDir, "sigintnoc.log");
    const l2Log = path.join(tmpDir, "sigintnoc.ndjson");

    fs.writeFileSync(replayLog, JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n");
    // No recorder_completed event in L2 file
    fs.writeFileSync(l2Log, JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ eventType: "market_trade", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n");

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: null, recorderSignal: "SIGINT" },
    });

    expect(manifest.validationErrors.some(e => e.includes("SIGINT") && e.includes("recorder_completed"))).toBeTrue();
    expect(manifest.pairValidity).toBe("invalid");
  });

  test("recorder_completed event seen with SIGINT produces expected_sigint stop reason", async () => {
    const replayLog = path.join(tmpDir, "sigintwithcomplete.log");
    const l2Log = path.join(tmpDir, "sigintwithcomplete.ndjson");

    fs.writeFileSync(replayLog, JSON.stringify({ ts: 2000, slug: "btc-updown-5m-100" }) + "\n" + JSON.stringify({ ts: 4000, slug: "btc-updown-5m-100" }) + "\n");
    // recorder_completed event IS present
    fs.writeFileSync(l2Log,
      JSON.stringify({ eventType: "market_book_snapshot", receivedTsMs: 1000, slug: "btc-updown-5m-100" }) + "\n" +
      JSON.stringify({ eventType: "market_trade", receivedTsMs: 5000, slug: "btc-updown-5m-100" }) + "\n" +
      JSON.stringify({ eventType: "recorder_completed", receivedTsMs: 5100, slug: "btc-updown-5m-100" }) + "\n"
    );

    const manifest = await validatePair("btc-updown-5m-100", replayLog, l2Log, "late-entry", {
      metadata: { recorderExitCode: null, recorderSignal: "SIGINT" },
    });

    expect(manifest.recorderStopReason).toBe("expected_sigint");
    expect(manifest.recorderCompletedEventSeen).toBeTrue();
    // No error for clean SIGINT with completed event
    expect(manifest.validationErrors.some(e => e.includes("SIGINT"))).toBeFalse();
    expect(manifest.pairValidity).toBe("valid");
  });

});
