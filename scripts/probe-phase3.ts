import { APIQueue } from "../tracker/api-queue.ts";
import { getSlug, getSlotTS } from "../utils/slot.ts";
import { Env } from "../utils/config.ts";
import { ClobClient, Chain } from "@polymarket/clob-client-v2";

async function main() {
  const apiQueue = new APIQueue();
  const clob = new ClobClient({ host: "https://clob.polymarket.com", chain: Chain.POLYGON });

  for (const offset of [0, 1]) {
    const slug = getSlug(offset);
    const slot = getSlotTS(offset);
    console.log(`\n--- Resolving Market (offset=${offset}) ---`);
    console.log(`Timestamp: ${Date.now()}`);
    console.log(`Slot Start: ${slot.startTime}`);
    console.log(`Slot End: ${slot.endTime}`);
    console.log(`Slug: ${slug}`);

    await apiQueue.queueEventDetails(slug);
    const event = apiQueue.eventDetails.get(slug);

    if (!event) {
      console.log(`Result: No event found for slug ${slug} in Gamma API.`);
      continue;
    }

    const market = event.markets[0];
    if (!market) {
      console.log(`Result: Event found, but no markets array in Gamma API.`);
      continue;
    }

    const tokenIds = JSON.parse(market.clobTokenIds);

    // Now cross-check with CLOB to get the fields the runtime ignores or guesses
    let clobMarket;
    try {
        clobMarket = await clob.getMarket(market.conditionId);
    } catch (e) {
        console.log(`Failed to fetch CLOB market: ${e}`);
    }

    console.log(`Question/Title: ${event.ticker ?? slug}`);
    console.log(`Condition ID: ${market.conditionId}`);
    console.log(`Closed (Gamma): ${market.closed}`);
    
    if (clobMarket) {
        console.log(`Closed (CLOB): ${clobMarket.closed}`);
        console.log(`AcceptingOrders (CLOB): ${clobMarket.accepting_orders}`);
        console.log(`TickSize (CLOB): ${clobMarket.minimum_tick_size}`);
        console.log(`NegRisk (CLOB): ${clobMarket.neg_risk}`);
    } else {
        console.log(`AcceptingOrders (CLOB): N/A`);
    }

    console.log(`UP Token ID: ${tokenIds[0]}`);
    console.log(`DOWN Token ID: ${tokenIds[1]}`);
    console.log(`Runtime assumed NegRisk: false`);
  }
}

main().catch(console.error);
