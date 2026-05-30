 
import { create } from 'zustand';
import type { Tz, DataSource } from '../utils/analytics/time';
import type { Asset, Duration } from '../utils/analytics/parse';

interface AnalyticsState {
  tz: Tz;
  asset: Asset;
  duration: Duration;
  strategy: string;
  dataSource: DataSource;
  setTz: (tz: Tz) => void;
  setAsset: (a: Asset) => void;
  setDuration: (d: Duration) => void;
  setStrategy: (s: string) => void;
  setDataSource: (s: DataSource) => void;
}

const STORAGE_TZ = "cockpit.analytics.tz";
const STORAGE_ASSET = "cockpit.analytics.asset";
const STORAGE_DURATION = "cockpit.analytics.duration";

function loadEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch { /* noop */ }
  return fallback;
}

export const useAnalyticsStore = create<AnalyticsState>((set) => ({
  tz: loadEnum(STORAGE_TZ, ["local", "ET", "UTC"] as const, "local"),
  asset: loadEnum(STORAGE_ASSET, ["BTC", "ETH", "XRP", "SOL", "DOGE"] as const, "BTC"),
  duration: loadEnum(STORAGE_DURATION, ["5m", "15m"] as const, "5m"),
  strategy: "All",
  dataSource: { kind: "default" },

  setTz: (tz) => {
    localStorage.setItem(STORAGE_TZ, tz);
    set({ tz });
  },
  setAsset: (asset) => {
    localStorage.setItem(STORAGE_ASSET, asset);
    set({ asset });
  },
  setDuration: (duration) => {
    localStorage.setItem(STORAGE_DURATION, duration);
    set({ duration });
  },
  setStrategy: (strategy) => set({ strategy }),
  setDataSource: (dataSource) => set({ dataSource }),
}));
