import type { EngineRuntimeOptions, EngineStatus } from "./bot-core/engine-runtime.ts";
import { EngineRuntime } from "./bot-core/engine-runtime.ts";
import type { ReplayMarketResult, Clock } from "./bot-core/index.ts";

export type { EngineStatus };

export class EarlyBird {
  private _runtime: EngineRuntime;

  constructor(
    strategyName: string | undefined,
    slotOffset = 1,
    prod = false,
    rounds: number | null = null,
    alwaysLog = false,
    replayFile?: string,
    clockOrOptions?: Clock | EngineRuntimeOptions,
  ) {
    this._runtime = new EngineRuntime(
      strategyName,
      slotOffset,
      prod,
      rounds,
      alwaysLog,
      replayFile,
      clockOrOptions
    );
  }

  // Wrapper getters and setters (for tests that aggressively mock private fields)
  get _spawner() { return (this._runtime as any)._spawner; }
  set _spawner(v) { (this._runtime as any)._spawner = v; }

  get _apiQueue() { return (this._runtime as any)._apiQueue; }
  set _apiQueue(v) { (this._runtime as any)._apiQueue = v; }

  get _client() { return (this._runtime as any)._client; }
  set _client(v) { (this._runtime as any)._client = v; }

  get _ticker() { return (this._runtime as any)._ticker; }
  set _ticker(v) { (this._runtime as any)._ticker = v; }

  get _tradeTape() { return (this._runtime as any)._tradeTape; }
  set _tradeTape(v) { (this._runtime as any)._tradeTape = v; }

  get _resolution() { return (this._runtime as any)._resolution; }
  set _resolution(v) { (this._runtime as any)._resolution = v; }

  get _binance() { return (this._runtime as any)._binance; }
  set _binance(v) { (this._runtime as any)._binance = v; }

  get _coinbase() { return (this._runtime as any)._coinbase; }
  set _coinbase(v) { (this._runtime as any)._coinbase = v; }

  get _aggregator() { return (this._runtime as any)._aggregator; }
  set _aggregator(v) { (this._runtime as any)._aggregator = v; }

  get _leadLag() { return (this._runtime as any)._leadLag; }
  set _leadLag(v) { (this._runtime as any)._leadLag = v; }

  get _quant() { return (this._runtime as any)._quant; }
  set _quant(v) { (this._runtime as any)._quant = v; }

  get _telemetry() { return (this._runtime as any)._telemetry; }
  set _telemetry(v) { (this._runtime as any)._telemetry = v; }

  get _eventWriter() { return (this._runtime as any)._eventWriter; }
  set _eventWriter(v) { (this._runtime as any)._eventWriter = v; }

  get _replayReader() { return (this._runtime as any)._replayReader; }
  set _replayReader(v) { (this._runtime as any)._replayReader = v; }

  get replayReader() { return this._runtime.replayReader; }

  get _tracker() { return (this._runtime as any)._tracker; }
  set _tracker(v) { (this._runtime as any)._tracker = v; }

  get _prod() { return (this._runtime as any)._prod; }
  set _prod(v) { (this._runtime as any)._prod = v; }

  get _rounds() { return (this._runtime as any)._rounds; }
  set _rounds(v) { (this._runtime as any)._rounds = v; }

  get _runtimeInstance() { return this._runtime; }


  get _shuttingDown() { return (this._runtime as any)._shuttingDown; }
  set _shuttingDown(v) { (this._runtime as any)._shuttingDown = v; }

  get isShuttingDown() { return this._runtime.isShuttingDown; }
  
  get activeLifecycleCount() { return this._runtime.activeLifecycleCount; }
  
  get replayStateSummary() { return this._runtime.replayStateSummary; }

  get _userChannelFactory() { return (this._runtime as any)._userChannelFactory; }
  set _userChannelFactory(v) { (this._runtime as any)._userChannelFactory = v; }

  
  // Public methods
  async start(): Promise<void> {
    return this._runtime.start();
  }

  async stop(): Promise<void> {
    return this._runtime.stop();
  }

  startShutdown(reason: string = "Manual"): void {
    return this._runtime.startShutdown(reason);
  }
  
  _startShutdown(reason: string): void {
    return (this._runtime as any)._startShutdown(reason);
  }

  async tickOnce(): Promise<void> {
    return this._runtime.tickOnce();
  }

  getStatus(): EngineStatus {
    return this._runtime.getStatus();
  }

  applyReplayMarketResult(result: ReplayMarketResult): void {
    return this._runtime.applyReplayMarketResult(result);
  }

  nextReplayDeadlineMs(): number | null {
    return this._runtime.nextReplayDeadlineMs();
  }
}
