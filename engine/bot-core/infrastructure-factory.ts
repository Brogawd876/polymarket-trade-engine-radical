import { Env } from "../../utils/config.ts";
import { log } from "../log.ts";
import { TickerTracker } from "../../tracker/ticker.ts";
import { ChainlinkResolutionAdapter } from "./chainlink-resolution-adapter.ts";
import { BinancePredictiveAdapter } from "./binance-predictive-adapter.ts";
import { CoinbasePredictiveAdapter } from "./coinbase-predictive-adapter.ts";
import { DefaultPredictiveAggregator } from "./predictive-signal-aggregator.ts";
import { DefaultLeadLagMonitor } from "./lead-lag-monitor.ts";
import { DefaultQuantMonitor } from "./quant-monitor.ts";
import { ReplayLogReader } from "./replay-log-reader.ts";
import { ReplayPredictiveAdapter } from "./replay-predictive-adapter.ts";
import { ReplayResolutionAdapter } from "./replay-resolution-adapter.ts";
import { ReplayTickerTracker } from "./replay-ticker-tracker.ts";
import type { ResolutionSourceAdapter, PredictiveFeedAdapter, Clock } from "./data-sources.ts";
import type { TelemetrySink } from "../telemetry/index.ts";

export interface BotInfrastructure {
  replayReader?: ReplayLogReader;
  ticker: TickerTracker | ReplayTickerTracker;
  resolution: ResolutionSourceAdapter;
  binance: PredictiveFeedAdapter;
  coinbase: PredictiveFeedAdapter;
  aggregator: DefaultPredictiveAggregator;
  leadLag: DefaultLeadLagMonitor;
  quant: DefaultQuantMonitor;
}

export interface InfrastructureFactoryOptions {
  replayFile?: string;
  clock: Clock;
  telemetry: TelemetrySink;
  strategyConfig: Record<string, unknown>;
}

export function buildBotInfrastructure(opts: InfrastructureFactoryOptions): BotInfrastructure {
  let replayReader: ReplayLogReader | undefined;
  let ticker: TickerTracker | ReplayTickerTracker;
  let resolution: ResolutionSourceAdapter;
  let binance: PredictiveFeedAdapter;
  let coinbase: PredictiveFeedAdapter;

  if (opts.replayFile) {
    log.write(`[startup] Replay mode enabled: ${opts.replayFile}`);
    replayReader = new ReplayLogReader(opts.replayFile);
    ticker = new ReplayTickerTracker(replayReader);
    resolution = new ReplayResolutionAdapter(replayReader);
    binance = new ReplayPredictiveAdapter("binance", replayReader);
    coinbase = new ReplayPredictiveAdapter("coinbase", replayReader);
  } else {
    ticker = new TickerTracker();
    resolution = new ChainlinkResolutionAdapter({
      clock: opts.clock,
      telemetry: opts.telemetry,
    });
    binance = new BinancePredictiveAdapter(opts.clock, opts.telemetry);
    coinbase = new CoinbasePredictiveAdapter(opts.clock, opts.telemetry);
  }

  const aggregator = new DefaultPredictiveAggregator({
    asset: Env.get("MARKET_ASSET"),
    feeds: {
      binance,
      coinbase,
    },
    feedWeights: {
      binance: 0.7, // Institutional weight: Binance usually has 10x liquidity
      coinbase: 0.3,
    },
    divergenceThresholdAbs: typeof opts.strategyConfig.divergenceThresholdAbs === "number"
      ? (opts.strategyConfig.divergenceThresholdAbs as number)
      : (process.env.DIVERGENCE_THRESHOLD ? parseFloat(process.env.DIVERGENCE_THRESHOLD) : undefined),
    resolution,
    clock: opts.clock,
  });

  const leadLag = new DefaultLeadLagMonitor({
    asset: Env.get("MARKET_ASSET"),
    aggregator,
    clock: opts.clock,
  });

  const quant = new DefaultQuantMonitor({
    asset: Env.get("MARKET_ASSET"),
    aggregator,
    resolution,
    clock: opts.clock,
  });

  return {
    replayReader,
    ticker,
    resolution,
    binance,
    coinbase,
    aggregator,
    leadLag,
    quant,
  };
}
