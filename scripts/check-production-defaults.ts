import { readFile } from "node:fs/promises";

const config = await readFile("utils/config.ts", "utf8");
const strategy = await readFile("engine/strategy/index.ts", "utf8");
const client = await readFile("engine/client.ts", "utf8");
const cancelSweep = await readFile("scripts/cancel-all-orders.ts", "utf8");

const failures: string[] = [];
if (!/\bPROD:\s*false\b/.test(config)) {
  failures.push("PROD must default to false");
}
if (!/POLY_SIGNATURE_TYPE:\s*-1\b/.test(config)) {
  failures.push("signature type must require explicit configuration");
}
if (!/DEFAULT_STRATEGY\s*=\s*["']simulation["']/.test(strategy)) {
  failures.push("default strategy must remain simulation-only");
}
if (!/_exchangeSubmissionEnabled\s*=\s*false\b/.test(client)) {
  failures.push("real exchange submission hard-disable is absent");
}
if (!/Intentionally tombstoned/.test(cancelSweep)) {
  failures.push("legacy unjournaled cancel sweep is not tombstoned");
}
if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log("Production-default guard passed");
}
