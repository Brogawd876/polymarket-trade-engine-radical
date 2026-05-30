import { StrategyLabBatchManager } from "../engine/strategy-lab.ts";
import { writeFileSync } from "fs";

async function runTest() {
  process.env.WALLET_BALANCE = "10";
  const manager = new StrategyLabBatchManager();
  
  const batch = await manager.createBatch({
    variants: ["fvm-v2.1.1-safeguarded"],
    files: ["logs/early-bird-btc-updown-5m-1778968200.log"],
    continuousBankroll: false,
  });
  
  let currentBatch = manager.getBatch(batch.id);
  while (currentBatch && (currentBatch.state === "queued" || currentBatch.state === "running")) {
      await new Promise(r => setTimeout(r, 1000));
      currentBatch = manager.getBatch(batch.id);
  }
  
  const run = currentBatch?.runs[0];
  writeFileSync("test_output.json", JSON.stringify(run, null, 2));
}

runTest().catch(console.error);
