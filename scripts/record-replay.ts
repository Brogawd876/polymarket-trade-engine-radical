import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { ChainlinkResolutionAdapter } from "../engine/bot-core/chainlink-resolution-adapter.ts";
import { BinancePredictiveAdapter } from "../engine/bot-core/binance-predictive-adapter.ts";
import { CoinbasePredictiveAdapter } from "../engine/bot-core/coinbase-predictive-adapter.ts";
import { slotFromSlug } from "../utils/slot.ts";
import type { ReplayEvent } from "../engine/bot-core/replay-log-reader.ts";
import { RealClock } from "../engine/bot-core/data-sources.ts";

function writeReplayEvent(filePath: string, event: ReplayEvent) {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(event) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  let slug = "";
  let durationMs = 300000; // 5 minutes default
  let outPath = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--slug") {
      slug = args[++i] || "";
    } else if (arg === "--duration-ms") {
      durationMs = parseInt(args[++i] || "300000", 10);
    } else if (arg === "--out") {
      outPath = args[++i] || "";
    }
  }

  if (!slug) {
    console.error("Usage: bun run scripts/record-replay.ts --slug <market-slug> [--duration-ms <ms>] [--out <path>]");
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production" || process.env.LIVE_TRADING_ENABLED === "true" || process.env.POLY_PROD === "true" || process.env.LIVE_TRADING === "true") {
    console.error("Cannot run in production or live environments.");
    process.exit(1);
  }

  outPath = outPath || join("logs", `early-bird-${slug}.log`);
  console.log(`[ReplayRecorder] Starting capture for slug: ${slug}`);
  console.log(`[ReplayRecorder] Output: ${outPath}`);
  console.log(`[ReplayRecorder] Duration: ${durationMs}ms`);

  const clock = new RealClock();
  
  // Resolve slot info
  const slot = slotFromSlug(slug);
  if (!slot) {
    console.error(`[ReplayRecorder] Failed to parse slot from slug: ${slug}`);
    process.exit(1);
  }

  // Write slot start event
  writeReplayEvent(outPath, {
    ts: clock.nowMs(),
    type: "slot",
    action: "start",
    slug,
    startTime: slot.startTime,
    endTime: slot.endTime,
    strategy: "record-only"
  });

  const handleTelemetry = (event: any) => {
    // Optional: map generic telemetry if needed.
    // In this script we rely on adapter subscribe events directly for replay-compatible logs.
  };

  const telemetrySink = { push: handleTelemetry };

  // Initialize adapters
  const chainlink = new ChainlinkResolutionAdapter({ clock, telemetry: telemetrySink });
  const binance = new BinancePredictiveAdapter(clock, telemetrySink);
  const coinbase = new CoinbasePredictiveAdapter(clock, telemetrySink);

  const handleResolutionEvent = (event: any) => {
    if (event.kind === "open") {
      writeReplayEvent(outPath, {
        ts: clock.nowMs(),
        type: "market_price",
        slug,
        kind: "open",
        openPrice: event.price,
        roundId: event.roundId,
        chainUpdatedAtMs: event.chainUpdatedAtMs,
        localReceivedAtMs: event.localReceivedAtMs,
      });
    }

    // Always emit chainlink_resolution for general compatibility
    writeReplayEvent(outPath, {
      ts: clock.nowMs(),
      type: "chainlink_resolution",
      kind: event.kind,
      price: event.price,
      rawOracleAnswer: event.rawOracleAnswer,
      roundId: event.roundId,
      answeredInRound: event.answeredInRound,
      chainUpdatedAtMs: event.chainUpdatedAtMs,
      localReceivedAtMs: event.localReceivedAtMs,
      oracleLagMs: event.oracleLagMs,
      quality: event.quality,
      stalenessStatus: event.stalenessStatus,
      source: event.source,
      sourceType: event.sourceType,
      contractAddress: event.metadata?.contractAddress,
    });
  };

  try {
    chainlink.subscribe(handleResolutionEvent);
    await chainlink.start();

    binance.subscribe((evt: any) => {
        writeReplayEvent(outPath, {
            ts: clock.nowMs(),
            type: "ticker",
            assetPrice: evt.price,
            binancePrice: evt.price,
        });
    });
    await binance.start();

    coinbase.subscribe((evt: any) => {
        writeReplayEvent(outPath, {
            ts: clock.nowMs(),
            type: "ticker",
            assetPrice: evt.price,
            coinbasePrice: evt.price,
        });
    });
    await coinbase.start();

    console.log(`[ReplayRecorder] Adapters started. Recording for ${durationMs}ms...`);
  } catch (e) {
    console.error(`[ReplayRecorder] Failed to start adapters:`, e);
    process.exit(1);
  }

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[ReplayRecorder] Shutting down...`);
    
    // Write slot end event
    writeReplayEvent(outPath, {
      ts: clock.nowMs(),
      type: "slot",
      action: "end",
      slug,
      startTime: slot.startTime,
      endTime: slot.endTime,
      strategy: "record-only"
    });

    try {
      chainlink.stop();
      binance.stop();
      coinbase.stop();
      console.log(`[ReplayRecorder] Exited safely.`);
      process.exit(0);
    } catch (e) {
      console.error(`[ReplayRecorder] Error during shutdown:`, e);
      process.exit(1);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stdin.on("data", (data) => {
    if (data.toString().trim().toLowerCase() === "stop") {
      shutdown();
    }
  });

  if (durationMs > 0) {
    setTimeout(() => {
      console.log(`[ReplayRecorder] Duration of ${durationMs}ms reached.`);
      shutdown();
    }, durationMs);
  }
}

main().catch((err) => {
  console.error("[ReplayRecorder] Unhandled error:", err);
  process.exit(1);
});
