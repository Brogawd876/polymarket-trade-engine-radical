import { resolveTradableBtc5mMarket } from "./btc-5m-market.ts";

type SourceReport = {
  source: string;
  connected: boolean;
  messagesSeen: number;
  tradeLikeMessagesSeen: number;
  tokenIdPresent: number;
  pricePresent: number;
  sizePresent: number;
  timestampPresent: number;
  slugOrMarketMatching: number;
  latencySamplesMs: {
    count: number;
    min: number | null;
    max: number | null;
    avg: number | null;
    recent: number[];
  };
  samplePayloads: unknown[];
  error?: string;
};

function parseArgs() {
  const args = process.argv.slice(2);
  let durationMs = 60_000;
  let minSecondsRemaining = 120;
  let slug: string | undefined;
  let upTokenId: string | undefined;
  let downTokenId: string | undefined;
  let conditionId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--duration-ms") durationMs = Number.parseInt(args[++i] ?? String(durationMs), 10);
    else if (arg === "--min-seconds-remaining") minSecondsRemaining = Number.parseInt(args[++i] ?? String(minSecondsRemaining), 10);
    else if (arg === "--slug") slug = args[++i];
    else if (arg === "--up-token-id") upTokenId = args[++i];
    else if (arg === "--down-token-id") downTokenId = args[++i];
    else if (arg === "--condition-id") conditionId = args[++i];
  }

  return { durationMs, minSecondsRemaining, slug, upTokenId, downTokenId, conditionId };
}

function emptyReport(source: string): SourceReport {
  return {
    source,
    connected: false,
    messagesSeen: 0,
    tradeLikeMessagesSeen: 0,
    tokenIdPresent: 0,
    pricePresent: 0,
    sizePresent: 0,
    timestampPresent: 0,
    slugOrMarketMatching: 0,
    latencySamplesMs: { count: 0, min: null, max: null, avg: null, recent: [] },
    samplePayloads: [],
  };
}

function isTradeLike(payload: any): boolean {
  const eventType = String(payload?.event_type ?? payload?.eventType ?? payload?.type ?? "").toLowerCase();
  return eventType === "last_trade_price" || eventType === "trade" || eventType === "trades";
}

function samplePayload(payload: any): unknown {
  return {
    event_type: payload?.event_type ?? payload?.eventType ?? payload?.type,
    market: payload?.market ?? payload?.conditionId ?? payload?.condition_id,
    asset_id: payload?.asset_id ?? payload?.asset ?? payload?.token_id ?? payload?.tokenId,
    price: payload?.price,
    size: payload?.size,
    side: payload?.side,
    timestamp: payload?.timestamp ?? payload?.match_time ?? payload?.matchtime ?? payload?.last_update,
    slug: payload?.slug ?? payload?.eventSlug,
    transaction_hash: payload?.transaction_hash ?? payload?.transactionHash,
  };
}

function observe(report: SourceReport, payload: any, opts: { tokenIds: Set<string>; conditionId?: string; slug?: string }) {
  report.messagesSeen++;
  if (isTradeLike(payload)) report.tradeLikeMessagesSeen++;

  const tokenId = payload?.asset_id ?? payload?.asset ?? payload?.token_id ?? payload?.tokenId;
  const price = payload?.price;
  const size = payload?.size;
  const timestamp = payload?.timestamp ?? payload?.match_time ?? payload?.matchtime ?? payload?.last_update;
  const market = payload?.market ?? payload?.conditionId ?? payload?.condition_id;
  const slug = payload?.slug ?? payload?.eventSlug;

  if (typeof tokenId === "string" && opts.tokenIds.has(tokenId)) report.tokenIdPresent++;
  if (price !== undefined && price !== null) report.pricePresent++;
  if (size !== undefined && size !== null) report.sizePresent++;
  if (timestamp !== undefined && timestamp !== null) report.timestampPresent++;
  if ((opts.conditionId && market === opts.conditionId) || (opts.slug && slug === opts.slug)) report.slugOrMarketMatching++;

  const tsMs = Number(timestamp) < 10_000_000_000 ? Number(timestamp) * 1000 : Number(timestamp);
  if (Number.isFinite(tsMs)) {
    const latency = Date.now() - tsMs;
    const stats = report.latencySamplesMs;
    stats.avg = stats.avg === null ? latency : ((stats.avg * stats.count) + latency) / (stats.count + 1);
    stats.count++;
    stats.min = stats.min === null ? latency : Math.min(stats.min, latency);
    stats.max = stats.max === null ? latency : Math.max(stats.max, latency);
    stats.recent.push(latency);
    if (stats.recent.length > 20) stats.recent.shift();
  }
  if (report.samplePayloads.length < 5 && (isTradeLike(payload) || report.samplePayloads.length === 0)) {
    report.samplePayloads.push(samplePayload(payload));
  }
}

async function probeMarketWs(opts: { tokenIds: string[]; conditionId?: string; slug?: string; durationMs: number }): Promise<SourceReport> {
  const report = emptyReport("market_ws");
  const tokenIds = new Set(opts.tokenIds);

  await new Promise<void>((resolve) => {
    const ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, opts.durationMs);

    ws.onopen = () => {
      report.connected = true;
      ws.send(JSON.stringify({
        type: "market",
        assets_ids: opts.tokenIds,
        custom_feature_enabled: true,
      }));
    };

    ws.onerror = () => {
      report.error = report.error ?? "websocket error";
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data));
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const message of messages) observe(report, message, { tokenIds, conditionId: opts.conditionId, slug: opts.slug });
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
      }
    };

    ws.onclose = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  return report;
}

async function probeClobLastTradePrices(tokenIds: string[]): Promise<SourceReport> {
  const report = emptyReport("clob_last_trades_prices");
  const tokenSet = new Set(tokenIds);
  try {
    const response = await fetch("https://clob.polymarket.com/last-trades-prices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenIds.map((tokenId) => ({ token_id: tokenId }))),
    });
    report.connected = response.ok;
    if (!response.ok) {
      report.error = `${response.status} ${response.statusText}`;
      return report;
    }
    const body = await response.json();
    const rows = Array.isArray(body) ? body : Array.isArray((body as any)?.data) ? (body as any).data : [];
    for (const row of rows) observe(report, row, { tokenIds: tokenSet });
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}

async function probeDataApiTrades(opts: { tokenIds: string[]; conditionId?: string; slug?: string }): Promise<SourceReport> {
  const report = emptyReport("data_api_trades");
  const tokenSet = new Set(opts.tokenIds);
  const query = opts.conditionId ? `?market=${encodeURIComponent(opts.conditionId)}&limit=100&takerOnly=false` : "?limit=100&takerOnly=false";
  try {
    const response = await fetch(`https://data-api.polymarket.com/trades${query}`);
    report.connected = response.ok;
    if (!response.ok) {
      report.error = `${response.status} ${response.statusText}`;
      return report;
    }
    const body = await response.json();
    const rows = Array.isArray(body) ? body : Array.isArray((body as any)?.data) ? (body as any).data : [];
    for (const row of rows) observe(report, row, { tokenIds: tokenSet, conditionId: opts.conditionId, slug: opts.slug });
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}

async function main() {
  const args = parseArgs();
  let market = args.slug && args.upTokenId && args.downTokenId && args.conditionId
    ? {
        slug: args.slug,
        upTokenId: args.upTokenId,
        downTokenId: args.downTokenId,
        conditionId: args.conditionId,
        secondsRemaining: null,
      }
    : await resolveTradableBtc5mMarket({ minSecondsRemaining: args.minSecondsRemaining });

  const tokenIds = [market.upTokenId, market.downTokenId];
  const reports = await Promise.all([
    probeMarketWs({ tokenIds, conditionId: market.conditionId, slug: market.slug, durationMs: args.durationMs }),
    probeClobLastTradePrices(tokenIds),
    probeDataApiTrades({ tokenIds, conditionId: market.conditionId, slug: market.slug }),
  ]);

  console.log(JSON.stringify({
    market,
    durationMs: args.durationMs,
    reports,
    evidenceHierarchy: {
      tier1: "Direct public trade print with tokenId, price, size, timestamp.",
      tier2: "Authenticated user trade/fill event; useful only for own fills.",
      tier3: "Last-trade price without size/timestamp; weak reference, not trade-through proof.",
      tier4: "Book touch only.",
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
