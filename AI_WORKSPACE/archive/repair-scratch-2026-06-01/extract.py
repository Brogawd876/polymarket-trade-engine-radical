import re
import sys

with open("engine/early-bird.ts.bak", "r", encoding="utf-8") as f:
    code = f.read()

# 1. Imports
code = code.replace(
    'import { CounterfactualRiskGate, type CounterfactualRiskMode } from "./replay/counterfactual-risk-gate.ts";',
    'import { CounterfactualRiskGate, type CounterfactualRiskMode } from "./replay/counterfactual-risk-gate.ts";\nimport { MarketSpawner } from "./bot-core/market-spawner.ts";'
)

# 2. Fields
code = code.replace('  private _lifecycles = new Map<string, MarketLifecycle>();\n', '')
code = code.replace('  private _completedSlugs = new Set<string>();\n', '')
code = code.replace('  private _roundsCreated = 0;\n', '')
code = code.replace('  private _tickInterval: unknown = null;\n', '')
code = code.replace('  private _lastPrefetchMs = 0;\n', '')
code = code.replace('  private _shuttingDown = false;\n', '  private _shuttingDown = false;\n  private _spawner!: MarketSpawner;\n')

# 3. Client Sim GetBook Callback
code = code.replace(
    'for (const lifecycle of this._lifecycles.values()) {',
    'const lifecycles = this._spawner ? this._spawner.getActiveLifecycles() : new Map<string, MarketLifecycle>();\n        for (const lifecycle of lifecycles.values()) {'
)
code = code.replace(
    'for (const lifecycle of this._lifecycles.values()) {',
    'const lifecycles = this._spawner ? this._spawner.getActiveLifecycles() : new Map<string, MarketLifecycle>();\n            for (const lifecycle of lifecycles.values()) {'
)

# 4. Spawner init in start()
# We need to inject it right before `if (this._replayReader) { log.write("[startup] Replay mode: skipping saved state recovery."); }`
init_hook = '      if (this._replayReader) {\n        log.write("[startup] Replay mode: skipping saved state recovery.");'
spawner_init = """
      this._spawner = new MarketSpawner({
        botContext: {
          ticker: this._ticker,
          resolution: this._resolution,
          binance: this._binance,
          coinbase: this._coinbase,
          aggregator: this._aggregator,
          leadLag: this._leadLag,
          quant: this._quant,
          replayReader: this._replayReader ? this._replayReader : undefined,
        },
        client: this._client,
        apiQueue: this._apiQueue,
        tradeTape: this._tradeTape,
        orderBookFactory: this._orderBookFactory,
        strategyName: this._strategyName,
        strategy: this._strategy,
        strategyConfig: this._strategyConfig,
        presetId: this._presetId,
        slotOffset: this._slotOffset,
        prod: this._prod,
        marketLogMode: this._marketLogMode,
        rounds: this._rounds,
        riskGate: this._riskGate,
        clock: this._clock,
        telemetry: this._telemetry,
        alwaysLog: this._alwaysLog,
        eventWriter: this._eventWriter,
        maintenance: this._maintenance,
        conservativeFill: this._conservativeFill,
        tracker: this._tracker,
        userChannel: this._userChannelFactory!(),
        replayVenueMetadata: this._replayVenueMetadata,
        onLifecycleDone: (slug, lifecycle) => {
          this._sessionPnl = parseFloat((this._sessionPnl + lifecycle.pnl).toFixed(4));
          if (lifecycle.pnl < 0) {
            this._sessionLoss = parseFloat((this._sessionLoss + lifecycle.pnl).toFixed(4));
          }
          log.write(`[${slug}] Session PnL: ${this._sessionPnl >= 0 ? "+" : ""}$${this._sessionPnl.toFixed(2)}`, this._sessionPnl >= 0 ? "green" : "red");
          this._telemetry.push({
            ts: this._clock.nowMs(),
            type: "SESSION_PNL",
            payload: { pnl: this._sessionPnl, loss: this._sessionLoss }
          });
          this._completedMarkets.push({
            slug,
            strategyName: lifecycle.strategyName,
            pnl: lifecycle.pnl,
            orderHistory: lifecycle.orderHistory,
          });

          if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
            this._startShutdown(`Session loss limit reached (total losses: $${this._sessionLoss.toFixed(2)}, threshold: -$${this._minSessionPnl.toFixed(2)}).`);
          }
          if (this._sessionPnl >= this._maxSessionProfit) {
            this._startShutdown(`Session profit target reached (total PnL: +$${this._sessionPnl.toFixed(2)}, target: +$${this._maxSessionProfit.toFixed(2)}).`);
          }
        },
        onTerminalError: (slug, err) => {
          this._startShutdown("Terminal Access Error");
        }
      });

"""
code = code.replace(init_hook, spawner_init + init_hook)

# 5. Recovery injection
code = code.replace(
    '          for (const [slug, lifecycle] of recovered) {\n            this._lifecycles.set(slug, lifecycle);\n          }',
    '          for (const [slug, lifecycle] of recovered) {\n            this._spawner.injectRecoveredLifecycle(slug, lifecycle);\n          }'
)

# 6. Start spawner instead of loop
start_loop = """      if (!this._replayReader) {
        log.write("[startup] Initializing predictive pre-fetching...");
        await this._apiQueue.prefetchFutureRounds();
        this._lastPrefetchMs = this._clock.nowMs();

        this._tickInterval = this._clock.setInterval(() => {
          this._tick().catch((e) => {
            if (e instanceof TerminalAccessError) {
              console.error(`\\n[fatal] ${e.message}\\n`);
              this._startShutdown("Terminal Access Error");
            } else {
              log.write(`[engine] tick error: ${e}`, "red");
            }
          });
        }, 10);
      }"""
code = code.replace(start_loop, '      await this._spawner.start();')

# 7. Getters
code = code.replace('return this._lifecycles.size;', 'return this._spawner ? this._spawner.activeLifecycleCount : 0;')
code = code.replace('this._lifecycles.size', '(this._spawner ? this._spawner.activeLifecycleCount : 0)')
code = code.replace('this._lifecycles.values()', '(this._spawner ? this._spawner.getActiveLifecycles().values() : [])')
code = code.replace('this._lifecycles.entries()', '(this._spawner ? this._spawner.getActiveLifecycles().entries() : [])')
code = code.replace('this._lifecycles', '(this._spawner ? this._spawner.getActiveLifecycles() : new Map())')

# 8. Replay proxy methods
code = code.replace(
    '  async tickOnce(): Promise<void> {\n    await this._tick();\n  }',
    '  async tickOnce(): Promise<void> {\n    if (this._spawner) await this._spawner.tickOnce();\n  }'
)
code = code.replace(
    '    if (!this._replayReader) return;\n    this._apiQueue.marketResult.set(result.startTime, {',
    '    if (!this._replayReader) return;\n    if (this._spawner) this._spawner.applyReplayMarketResult(result);\n    this._apiQueue.marketResult.set(result.startTime, {'
)

# 9. Stop method
stop_method_find = """  async stop(): Promise<void> {
    this._startShutdown("Explicit stop requested");
    // Wait for lifecycles to settle
    let attempts = 0;
    while (this._lifecycles.size > 0 && attempts < 20) {
      await new Promise((r) => setTimeout(r, 500));
      attempts++;
    }

    if (this._tickInterval) this._clock.clearInterval(this._tickInterval);"""
stop_method_replace = """  async stop(): Promise<void> {
    this._startShutdown("Explicit stop requested");
    if (this._spawner) await this._spawner.stop();"""

# Remove the actual `_tick` method block via regex
tick_method_re = re.compile(r'  private async _tick\(\): Promise<void> \{.*?\n  \}\n\n  private async _emitRunCompleted', re.DOTALL)
code = tick_method_re.sub('  private async _emitRunCompleted', code)

code = code.replace(
"""  async stop(): Promise<void> {
    this._startShutdown("Explicit stop requested");
    // Wait for lifecycles to settle
    let attempts = 0;
    while ((this._spawner ? this._spawner.activeLifecycleCount : 0) > 0 && attempts < 20) {
      await new Promise((r) => setTimeout(r, 500));
      attempts++;
    }

    if (this._tickInterval) this._clock.clearInterval(this._tickInterval);""",
"""  async stop(): Promise<void> {
    this._startShutdown("Explicit stop requested");
    if (this._spawner) await this._spawner.stop();"""
)

# Replace the remaining lifecycles loop in startShutdown
code = code.replace(
"""    for (const [, lifecycle] of (this._spawner ? this._spawner.getActiveLifecycles() : new Map())) {
      lifecycle.shutdown();
    }""",
"""    if (this._spawner) this._spawner.startShutdown();"""
)

with open("engine/early-bird.ts", "w", encoding="utf-8") as f:
    f.write(code)
