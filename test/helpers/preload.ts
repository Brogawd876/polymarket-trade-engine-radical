import { mock } from "bun:test";

class MockLog {
  write() {}
  flush() {}
}
mock.module("../../engine/log", () => ({
  log: new MockLog(),
}));

mock.module("../../engine/logger", () => ({
  Logger: class {
    setSnapshotProvider() {}
    setMarketResultProvider() {}
    setTickerProvider() {}
    setResolutionProvider() {}

    startSlot() {}
    endSlot() {}
    destroy() {}
    log() {}
    snapshot() {}
  },
}));
