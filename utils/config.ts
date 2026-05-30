export type MarketWindow = "5m" | "15m";
export type MarketAsset = "btc" | "eth" | "xrp" | "sol" | "doge";

export type Config = {
  TICKER: ("polymarket" | "binance" | "coinbase" | "okx" | "bybit")[];
  MARKET_WINDOW: MarketWindow;
  MARKET_ASSET: MarketAsset;
  PROD: boolean;
  BINANCE_US: boolean;
  PRIVATE_KEY: string;
  POLY_FUNDER_ADDRESS: string;
  POLY_SIGNATURE_TYPE: number;
  POLY_API_KEY_NONCE: number;
  POLYGON_RPC_URL: string;
  BUILDER_KEY: string;
  BUILDER_SECRET: string;
  BUILDER_PASSPHRASE: string;
  OPERATOR_AUTH_TOKEN: string;
  CHAINLINK_BTC_5M_REFERENCE_VERIFIED: boolean;
  MAX_SESSION_PROFIT: number;
};

const ASSET_TICKER_MAP: Record<
  MarketAsset,
  {
    slugPrefix: string;
    binanceStream: string;
    coinbaseProduct: string;
    polymarketSymbol: string;
    apiSymbol: string;
    okxInstId: string;
    bybitSymbol: string;
  }
> = {
  btc: {
    slugPrefix: "btc",
    binanceStream: "btcusdt",
    coinbaseProduct: "BTC-USD",
    polymarketSymbol: "btc/usd",
    apiSymbol: "BTC",
    okxInstId: "BTC-USD",
    bybitSymbol: "BTCUSDT",
  },
  eth: {
    slugPrefix: "eth",
    binanceStream: "ethusdt",
    coinbaseProduct: "ETH-USD",
    polymarketSymbol: "eth/usd",
    apiSymbol: "ETH",
    okxInstId: "ETH-USD",
    bybitSymbol: "ETHUSDT",
  },
  xrp: {
    slugPrefix: "xrp",
    binanceStream: "xrpusdt",
    coinbaseProduct: "XRP-USD",
    polymarketSymbol: "xrp/usd",
    apiSymbol: "XRP",
    okxInstId: "XRP-USD",
    bybitSymbol: "XRPUSDT",
  },
  sol: {
    slugPrefix: "sol",
    binanceStream: "solusdt",
    coinbaseProduct: "SOL-USD",
    polymarketSymbol: "sol/usd",
    apiSymbol: "SOL",
    okxInstId: "SOL-USD",
    bybitSymbol: "SOLUSDT",
  },
  doge: {
    slugPrefix: "doge",
    binanceStream: "dogeusdt",
    coinbaseProduct: "DOGE-USD",
    polymarketSymbol: "doge/usd",
    apiSymbol: "DOGE",
    okxInstId: "DOGE-USD",
    bybitSymbol: "DOGEUSDT",
  },
};

export class Env {
  private static readonly defaults: Config = {
    TICKER: ["polymarket", "coinbase"],
    MARKET_WINDOW: "5m",
    MARKET_ASSET: "btc",
    PROD: false,
    BINANCE_US: false,
    PRIVATE_KEY: "",
    POLY_FUNDER_ADDRESS: "",
    POLY_SIGNATURE_TYPE: -1, // Force explicit config
    POLY_API_KEY_NONCE: 1,
    POLYGON_RPC_URL: "https://polygon-bor-rpc.publicnode.com",
    BUILDER_KEY: "",
    BUILDER_SECRET: "",
    BUILDER_PASSPHRASE: "",
    OPERATOR_AUTH_TOKEN: "",
    CHAINLINK_BTC_5M_REFERENCE_VERIFIED: false,
    MAX_SESSION_PROFIT: 1_000_000, // Effectively disabled by default
  };

  static get<T extends keyof Config>(key: T): Config[T] {
    const raw = process.env[key];
    const defaultVal = this.defaults[key];

    // No env var set, return default
    if (raw === undefined) return defaultVal;

    // Infer type from default value
    if (typeof defaultVal === "boolean") {
      return (raw === "true") as Config[T];
    }

    if (typeof defaultVal === "number") {
      return parseInt(raw, 10) as Config[T];
    }

    if (Array.isArray(defaultVal)) {
      return raw.split(",").map((s) => s.trim()) as Config[T];
    }

    return raw as Config[T];
  }

  static getAssetConfig() {
    const asset = Env.get("MARKET_ASSET");
    const config = ASSET_TICKER_MAP[asset];
    if (!config) {
      throw new Error(
        `Invalid MARKET_ASSET "${asset}". Must be one of: ${Object.keys(ASSET_TICKER_MAP).join(", ")}`,
      );
    }
    return config;
  }
}
