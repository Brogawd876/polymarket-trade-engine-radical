import { Command } from "commander";
import * as readline from "readline";
import { strategies, DEFAULT_STRATEGY, strategyVariants } from "./engine/strategy/index.ts";
import { acquireProcessLock } from "./utils/process-lock.ts";
import { validateContracts } from "./utils/contracts.ts";
import { 
    TelemetryBus,
    ControlServer
} from "./engine/bot-core/index.ts";
import { SessionManager } from "./engine/session-manager.ts";

const program = new Command()
  .description(
    "Automated trading engine for Polymarket binary prediction markets (e.g. BTC Up/Down 5-minute) ", 
  )
  .option(
    "-s, --strategy <name>",
    `Strategy to run (${Object.keys(strategies).join(", ")})`,
    DEFAULT_STRATEGY,
  )
  .option(
    "--slot-offset <n>",
    "Which future market slot to pre-enter or trade in current market (1 = next slot, 2 = slot after next, …)",
    (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1)
        throw new Error("--slot-offset must be a positive integer");
      return n;
    },
    1,
  )
  .option(
    "--prod",
    "Run against the real Polymarket CLOB (requires PRIVATE_KEY)",
  )
  .option(
    "--rounds <n>",
    "Number of market rounds to trade then exit (0 = recover existing only, omit for unlimited)",     
    (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0)
        throw new Error("--rounds must be a non-negative integer");
      return n;
    },
  )
  .option(
    "--always-log",
    "Always write the slot log file even if no market was entered (useful for debugging)",
  )
  .option(
    "--replay <file>",
    "Run in historical replay mode using the specified log file",
  )
  .option(
    "--port <n>",
    "Port for the control plane server (default: 3000)",
    (v) => parseInt(v, 10),
    3000
  )
  .option(
    "--no-server",
    "Disable the control plane server"
  )
  .option(
    "--idle",
    "Start the control plane server in idle mode and wait for UI commands"
  )
  .parse();

const opts = program.opts<{
  strategy: string;
  slotOffset: number;
  prod?: boolean;
  rounds?: number;
  alwaysLog?: boolean;
  replay?: string;
  port: number;
  server: boolean;
  idle?: boolean;
}>();

acquireProcessLock("early-bird");
validateContracts({
  requireSettlementReferenceVerification:
    Boolean(opts.prod) && !opts.replay && !opts.idle,
});

if (!strategies[opts.strategy] && !strategyVariants[opts.strategy] && !opts.idle && !opts.replay) {
  console.error(`Unknown strategy: "${opts.strategy}"`);
  console.error(`Available: ${Object.keys(strategies).join(", ")}, ${Object.keys(strategyVariants).join(", ")}`);
  process.exit(1);
}

if (opts.prod && process.env.FORCE_PROD !== "true" && !opts.idle) {
  const answer = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(
      "Run in PRODUCTION mode with real funds? Enter Y to confirm: ",
      (ans) => {
        rl.close();
        resolve(ans);
      },
    );
  });

  if (answer !== "Y") {
    console.log("Aborted.");
    process.exit(0);
  }

  process.env.PROD = "true";
}

// Telemetry & Control Plane
const telemetryBus = new TelemetryBus();
const sessionManager = new SessionManager(telemetryBus);

// Start Control Plane Server
let controlServer: ControlServer | undefined;
if (opts.server) {
    controlServer = new ControlServer({
        port: opts.port,
        telemetryBus,
        sessionManager
    });
    controlServer.start();
}

if (opts.idle) {
  console.log("Engine running in idle mode. Waiting for control plane commands.");
} else {
  if (opts.replay) {
    await sessionManager.startReplay(opts.replay, { strategy: opts.strategy });
    // When started from CLI without idle, we exit when completed
    setInterval(() => {
        if (sessionManager.getStatus().sessionState === "completed" || sessionManager.getStatus().sessionState === "failed") {
            if (controlServer) controlServer.stop();
            process.exit(sessionManager.getStatus().sessionState === "failed" ? 1 : 0);
        }
    }, 1000);
  } else {
    try {
      await sessionManager.startSimulation({
        strategy: opts.strategy,
        rounds: opts.rounds,
        alwaysLog: opts.alwaysLog,
        prod: Boolean(opts.prod),
        slotOffset: opts.slotOffset
      });

      // Monitor for completion
      setInterval(() => {
          if (sessionManager.getStatus().sessionState === "completed" || sessionManager.getStatus().sessionState === "failed") {
              if (controlServer) controlServer.stop();
              process.exit(sessionManager.getStatus().sessionState === "failed" ? 1 : 0);
          }
      }, 1000);
    } catch (e: any) {
      console.error(e.message);
      if (controlServer) controlServer.stop();
      process.exit(1);
    }
  }
}
