import { performance } from "perf_hooks";

async function ping(url: string, name: string) {
  const start = performance.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    const end = performance.now();
    console.log(`[${name}] HTTP Latency: ${(end - start).toFixed(2)}ms`);
  } catch (err: any) {
    console.log(`[${name}] Error: ${err.message}`);
  }
}

async function run() {
  console.log("Measuring current network connection latency to exchanges...\n");
  
  // Test each endpoint 3 times to get an average
  for (let i = 1; i <= 3; i++) {
    console.log(`--- Ping Test ${i} ---`);
    await ping("https://clob.polymarket.com/time", "Polymarket CLOB ");
    await ping("https://api.binance.com/api/v3/ping", "Binance API     ");
    await ping("https://api.exchange.coinbase.com/time", "Coinbase API    ");
    console.log("");
    // sleep slightly between pings
    await new Promise(r => setTimeout(r, 500));
  }
}

run();
