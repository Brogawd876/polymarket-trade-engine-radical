import { ClobClient, Chain } from "@polymarket/clob-client-v2";
import { APIQueue } from "../tracker/api-queue.ts";
import { getSlug, slotFromSlug } from "../utils/slot.ts";

export type Btc5mMarket = {
  slug: string;
  question: string;
  conditionId: string;
  acceptingOrders: boolean;
  closed: boolean;
  tickSize: string;
  negRisk: boolean;
  upTokenId: string;
  downTokenId: string;
  chosenTokenId: string;
  secondsRemaining: number;
};

function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function parseTokenIds(raw: unknown): [string, string] | null {
  if (Array.isArray(raw) && raw.length >= 2) return [String(raw[0]), String(raw[1])];
  if (typeof raw !== "string") return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 2) return null;
  return [String(parsed[0]), String(parsed[1])];
}

async function chooseNonMarketableBuyToken(
  clob: ClobClient,
  upTokenId: string,
  downTokenId: string,
): Promise<string> {
  const books = await Promise.all([
    clob.getOrderBook(upTokenId),
    clob.getOrderBook(downTokenId),
  ]);
  const candidates = [
    { tokenId: upTokenId, book: books[0] },
    { tokenId: downTokenId, book: books[1] },
  ];
  const safeCandidate = candidates.find(({ book }) => {
    const asks = ((book as any)?.asks ?? []) as Array<{ price?: string }>;
    const bestAsk = asks.length > 0 ? Number(asks[0]?.price) : Number.NaN;
    return Number.isNaN(bestAsk) || bestAsk > 0.01;
  });
  return safeCandidate?.tokenId ?? upTokenId;
}

export async function resolveTradableBtc5mMarket(
  opts: { minSecondsRemaining?: number; maxOffset?: number } = {},
): Promise<Btc5mMarket> {
  const minSecondsRemaining = opts.minSecondsRemaining ?? 45;
  const maxOffset = opts.maxOffset ?? 4;
  const apiQueue = new APIQueue();
  const clob = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: Chain.POLYGON,
  });

  for (let offset = 0; offset <= maxOffset; offset++) {
    const slug = getSlug(offset);
    const slot = slotFromSlug(slug);
    const secondsRemaining = Math.floor((slot.endTime - Date.now()) / 1000);
    if (secondsRemaining < minSecondsRemaining) continue;

    await apiQueue.queueEventDetails(slug);
    const event = apiQueue.eventDetails.get(slug);
    const market = event?.markets?.[0];
    if (!event || !market) continue;

    const tokenIds = parseTokenIds(market.clobTokenIds);
    if (!tokenIds) continue;

    const clobMarket = await clob.getMarket(market.conditionId);
    const acceptingOrders = asBoolean(
      clobMarket.accepting_orders ?? clobMarket.acceptingOrders,
    );
    const closed = asBoolean(clobMarket.closed ?? market.closed);
    if (!acceptingOrders || closed) continue;

    const tickSize = String(
      clobMarket.minimum_tick_size ??
        clobMarket.minimumTickSize ??
        (await clob.getTickSize(tokenIds[0])),
    );
    const negRisk = asBoolean(
      clobMarket.neg_risk ?? clobMarket.negRisk ?? event.negRisk,
    );
    const chosenTokenId = await chooseNonMarketableBuyToken(
      clob,
      tokenIds[0],
      tokenIds[1],
    );

    return {
      slug,
      question: String((clobMarket as any).question ?? event.ticker ?? slug),
      conditionId: market.conditionId,
      acceptingOrders,
      closed,
      tickSize,
      negRisk,
      upTokenId: tokenIds[0],
      downTokenId: tokenIds[1],
      chosenTokenId,
      secondsRemaining,
    };
  }

  throw new Error(
    `No currently tradable BTC 5-minute market found within ${maxOffset + 1} slots`,
  );
}
