import { test, expect, describe } from "bun:test";
import { execSync } from "child_process";

describe("record-replay.ts script", () => {
  test("refuses to run in NODE_ENV=production", () => {
    try {
      execSync("bun run scripts/record-replay.ts --slug btc-updown-5m-100 --duration-ms 100", {
        env: { ...process.env, NODE_ENV: "production" },
        stdio: "pipe"
      });
      expect().fail("Should have thrown an error");
    } catch (e: any) {
      expect(e.message + " " + (e.stdout ? e.stdout.toString() : "") + " " + (e.stderr ? e.stderr.toString() : "")).toContain("Cannot run in production or live environments");
    }
  });

  test("refuses to run in LIVE_TRADING_ENABLED=true", () => {
    try {
      execSync("bun run scripts/record-replay.ts --slug btc-updown-5m-100 --duration-ms 100", {
        env: { ...process.env, LIVE_TRADING_ENABLED: "true" },
        stdio: "pipe"
      });
      expect().fail("Should have thrown an error");
    } catch (e: any) {
      expect(e.message + " " + (e.stdout ? e.stdout.toString() : "") + " " + (e.stderr ? e.stderr.toString() : "")).toContain("Cannot run in production or live environments");
    }
  });
});
