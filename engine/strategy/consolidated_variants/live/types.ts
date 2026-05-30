import type { PendingOrder } from "../market-lifecycle.ts";
import type { OrderBook } from "../../tracker/orderbook.ts";
import type { Order, CancelOrderResponse } from "../../utils/trading.ts";
import type { LogColor } from "../log.ts";
import type { TickerTracker } from "../../tracker/ticker";
import type { MarketData } from "../../tracker/api-queue.ts";
import type {
  ResolutionSourceAdapter,
  VenueDataAdapter,
  PredictiveFeedAdapter,
  PredictiveSignalAggregator,
  LeadLagMonitor,
  OrderFlowMonitor,
  QuantMonitor,
  Clock,
} from "../bot-core/data-sources.ts";

export type OrderRequest = {
  req: {
    tokenId: string;
    action: "buy" | "sell";
    price: number;
    shares: number;
    orderType?: "GTC" | "FOK";
  };
  /** Unix timestamp (ms) after which the order should be cancelled. Compared against `Date.now()`. */
  expireAtMs: number;
  onFilled?: (filledShares: number) => void;
  onExpired?: () => void;
  onFailed?: (reason: string) => void;
};

/** Context exposed to strategies — subset of lifecycle internals. */
export type StrategyContext = {
  slug: string;
  strategyName: string;
  strategyConfig: Record<string, unknown>;
  slotStartMs: number;
  slotEndMs: number;
  clobTokenIds: [string, string];
  orderBook: OrderBook;
  log: (msg: string, color?: LogColor) => void;

  getOrderById: (orderId: string) => Promise<Order | null>;
  /**
   * Fire-and-forget order placement. Returns immediately — do not use the
   * return value to determine if an order was placed. Use `onFilled` to react
   * to a successful fill and `onExpired` to react to a cancellation or failed
   * placement. Buys are dropped if buy-blocked; sells are dropped if sell-blocked.
   */
  postOrders: (orders: OrderRequest[]) => void;
  /** Cancel orders in batch. Only removes pending orders that were actually canceled. */
  cancelOrders: (orderIds: string[]) => Promise<CancelOrderResponse>;
  /** Cancel pending sells and re-place at best bid for immediate exit. Bypasses sell block. */
  emergencySells: (orderIds: string[]) => Promise<void>;

  blockBuys: () => void;
  blockSells: () => void;
  /**
   * Prevent the lifecycle from exiting RUNNING while the strategy is still
   * active (e.g. waiting for a price condition before placing orders).
   * Returns a `release` function — call it when the hold is no longer needed.
   * The lifecycle stays RUNNING until all active holds are released.
   */
  hold: () => () => void;

  pendingOrders: PendingOrder[];
  orderHistory: Array<{
    action: "buy" | "sell";
    tokenId: string;
    price: number;
    shares: number;
  }>;

  ticker: TickerTracker;
  /** Read-only access to market open/close price data when available. */
  getMarketResult: () => MarketData | undefined;
  /** Access to the normalized resolution source truth (Chainlink-style). */
  resolution?: ResolutionSourceAdapter;
  /** Access to the normalized Polymarket venue state (orderbook, fees). */
  venue?: VenueDataAdapter;
  /** Access to predictive exchange feeds. */
  predictive?: {
    binance?: PredictiveFeedAdapter;
    coinbase?: PredictiveFeedAdapter;
    /** Unified view of all predictive feeds (average price, divergence, disagreement). */
    aggregate?: PredictiveSignalAggregator;
    /** Tracks observed feed timing leadership across exchanges. */
    leadLag?: LeadLagMonitor;
  };
  /** Tracks Polymarket Order Book Flow and Whale activity. */
  orderFlow?: OrderFlowMonitor;
  /** Fair-value probability and realized-volatility model shared by strategies. */
  quant?: QuantMonitor;
  /** Shared clock (real or virtual). Use this for all timers and Date.now(). */
  clock: Clock;
};

/**
 * A strategy is a function called once after INIT completes.
 * It places initial orders with callbacks that chain further logic.
 *
 * Optionally return a cleanup function to be called when the lifecycle is
 * destroyed. Use this to clear any timers or intervals the strategy created,
 * similar to the cleanup return in React's useEffect.
 */
export type Strategy = (ctx: StrategyContext) => Promise<(() => void) | void>;
