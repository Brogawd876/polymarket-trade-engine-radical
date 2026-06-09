import type { Order, CancelOrderResponse, OrderType } from "../utils/trading";

import {
  ClobClient,
  Side,
  OrderType as ClobOrderType,
  type UserOrderV2 as UserOrder,
  AssetType,
  type TickSize,
  Chain,
} from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { Env } from "../utils/config";
import { POLYGON_CONTRACTS } from "../utils/contracts.ts";
import { type Clock, RealClock } from "./bot-core/data-sources.ts";
import { ConservativeMakerFillModel, type FillModelBook, type FillModelOrder } from "./replay/fill-model.ts";


const RELAYER_URL = "https://relayer-v2.polymarket.com";
const POLYGON_RPC = Env.get("POLYGON_RPC_URL");
const CTF_ADDRESS = POLYGON_CONTRACTS.CONDITIONAL_TOKENS as `0x${string}`;
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const pUSD_ADDRESS = POLYGON_CONTRACTS.PUSD as `0x${string}`;
const ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee" as const;
const OFFRAMP = "0x2957922Eb93258b93368531d39fAcCA3B4dC5854" as const;

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const RAMP_ABI = parseAbi([
  "function wrap(address _asset, address _to, uint256 _amount)",
  "function unwrap(address _asset, address _to, uint256 _amount)",
]);

const CTF_REDEEM_ABI = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
]);

function simulateDelay(clock: Clock, fixedDelayMs?: number) {
  const ms = parseInt(process.env.SIM_DELAY_MS ?? "", 10);
  const delay = isNaN(ms) ? 150 + Math.random() * 10 : ms; // default 150–160ms
  if (fixedDelayMs !== undefined && fixedDelayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) =>
    clock.setTimeout(() => resolve(), fixedDelayMs ?? delay),
  );
}

export type MultiOrderRequest = {
  tokenId: string;
  action: "buy" | "sell";
  price: number;
  shares: number;
  tickSize: string;
  negRisk: boolean;
  feeRateBps: number; // deprecated field not used in v2
  orderType?: "GTC" | "FOK" | "GTD";
  expiration?: number; // seconds from now
};

export type PlacedOrder = {
  orderId: string;
  status: string;
  success: boolean;
  errorMsg: string;
};

export interface EarlyBirdClient {
  init(): Promise<void>;
  postMultipleOrders(orders: MultiOrderRequest[]): Promise<PlacedOrder[]>;
  getOpenOrderIds(conditionId: string): Promise<Set<string>>;
  getOrderById(orderId: string): Promise<Order | null>;
  cancelOrder(orderId: string): Promise<void>;
  cancelOrders(orderIds: string[]): Promise<CancelOrderResponse>;
  /** Re-insert a persisted order (for startup recovery). No-op for real client. */
  restoreOrder(order: Order): void;

  /** Safety & Heartbeat */
  sendHeartbeat(): Promise<void>;

  /** Balance API */
  getUSDCBalance(): Promise<number>;
  getAvailableShares(tokenId: string): Promise<number>;
  updateUSDCBalance(): Promise<void>;
  updateAvailableShares(tokenId: string): Promise<void>;

  /** Activity API */
  getActivity(type?: string): Promise<any[]>;

  /** Redeem winning CTF positions for a resolved market. No-op in sim mode. */
  redeemPositions(conditionId: string, silent?: boolean): Promise<void>;

  /** Wrap USDC.e -> pUSD via the Polymarket relayer. No-op in sim mode. */
  wrapUSDC(amount: bigint): Promise<void>;
  /** Unwrap pUSD -> USDC.e via the Polymarket relayer. No-op in sim mode. */
  unwrapUSDC(amount: bigint): Promise<void>;
  /** Read the funder wallet's on-chain ERC-20 balance for any token. Returns 0n in sim mode. */
  getTokenBalance(token: `0x${string}`): Promise<bigint>;
}

export type BookSnapshot = {
  bestAsk: number | null;
  bestAskLiquidity: number | null;
  bestBid: number | null;
  bestBidLiquidity: number | null;
};

/**
 * Sim fill check: price must cross and the counterparty liquidity at best
 * price must exceed a buffer to avoid fills on thin, illiquid ticks.
 */
export function isSimFilled(
  order: { action: "buy" | "sell"; price: number; shares: number },
  book: BookSnapshot,
): boolean {
  const isPessimistic = process.env.PESSIMISTIC_FILL === "true";

  // Neutral: 2x buffer. Pessimistic: 10x buffer + 1c hurdle
  const multiplier = isPessimistic ? 10 : 2;
  const hurdle = isPessimistic ? 0.01 : 0;

  const requiredLiquidity = order.shares * order.price * multiplier;

  if (order.action === "buy") {
    return (
      book.bestAsk !== null &&
      book.bestAsk <= (order.price - hurdle) &&
      (book.bestAskLiquidity ?? 0) > requiredLiquidity
    );
  } else {
    return (
      book.bestBid !== null &&
      book.bestBid >= (order.price + hurdle) &&
      (book.bestBidLiquidity ?? 0) > requiredLiquidity
    );
  }
}


/** How long after a buy fills before the sim allows sells on that token. */
function simBalanceDelayMs(): number {
  const parsed = parseInt(process.env.SIM_BALANCE_DELAY_MS ?? "4000", 10);
  return Number.isNaN(parsed) ? 4000 : parsed;
}

export class EarlyBirdSimClient implements EarlyBirdClient {
  private _orders = new Map<string, Order>();
  /** tokenId → earliest ms at which sells can be placed (simulates on-chain balance delay). */
  private _balanceReadyAt = new Map<string, number>();
  /** orderId → callback invoked when the sim client cancels that order. Used by SimUserChannel
   *  to synthesize CANCELLATION events, letting tests verify untrackOrder suppresses onFailed. */
  readonly cancelCallbacks = new Map<string, () => void>();
  private readonly _clock: Clock;
  private readonly _fixedDelayMs?: number;
  private readonly _conservativeFill: boolean;

  constructor(
    private getBook: (tokenId: string) => FillModelBook | BookSnapshot | null,
    opts: { clock?: Clock; fixedDelayMs?: number; conservativeFill?: boolean } = {},
  ) {
    this._clock = opts.clock ?? new RealClock();
    this._fixedDelayMs = opts.fixedDelayMs;
    this._conservativeFill = opts.conservativeFill ?? true;
  }

  async init(): Promise<void> {}

  async sendHeartbeat(): Promise<void> {}

  private _checkFill(
    order: { action: "buy" | "sell"; price: number; shares: number; orderType?: OrderType },
    bookData: FillModelBook | BookSnapshot | null,
  ): boolean {
    if (!bookData) return false;

    const isConservative =
      this._conservativeFill !== false &&
      process.env.OPTIMISTIC_FILL !== "true";

    if (isConservative && "bids" in bookData && "asks" in bookData) {
      const model = new ConservativeMakerFillModel();
      const result = model.evaluate(
        {
          action: order.action,
          side: "UP", // side is not used for maker/taker classification logic
          price: order.price,
          shares: order.shares,
          orderType: (order.orderType as any) ?? "GTC",
        },
        bookData as FillModelBook,
      );
      return result.filled;
    }

    // Fallback to optimistic
    const snap: BookSnapshot = ("bids" in bookData)
      ? {
          bestAsk: (bookData as FillModelBook).asks[0]?.[0] ?? null,
          bestAskLiquidity: (bookData as FillModelBook).asks[0]?.[1] ?? null,
          bestBid: (bookData as FillModelBook).bids[0]?.[0] ?? null,
          bestBidLiquidity: (bookData as FillModelBook).bids[0]?.[1] ?? null,
        }
      : (bookData as BookSnapshot);

    return isSimFilled(order, snap);
  }

  async postMultipleOrders(
    orders: MultiOrderRequest[],
  ): Promise<PlacedOrder[]> {
    await simulateDelay(this._clock, this._fixedDelayMs);
    return orders.map((req) => {
      if (req.action === "sell") {
        const readyAt = this._balanceReadyAt.get(req.tokenId) ?? 0;
        if (this._clock.nowMs() < readyAt) {
          return {
            orderId: "",
            status: "",
            success: true,
            errorMsg:
              "not enough balance / allowance: the balance is not enough -> balance: 0, order amount: 6000000",
          };
        }
      }

      // FOK: fill immediately or reject — matches real CLOB behavior
      if (req.orderType === "FOK") {
        const book = this.getBook(req.tokenId);
        if (this._checkFill(req, book)) {
          const orderId = crypto.randomUUID();
          this._orders.set(orderId, {
            id: orderId,
            tokenId: req.tokenId,
            action: req.action,
            price: req.price,
            shares: req.shares,
            actualShares: req.shares,
            status: "filled",
          });
          if (req.action === "buy") {
            this._balanceReadyAt.set(
              req.tokenId,
              this._clock.nowMs() + simBalanceDelayMs(),
            );
          }
          return { orderId, status: "matched", success: true, errorMsg: "" };
        }
        return {
          orderId: "",
          status: "",
          success: true,
          errorMsg:
            "order couldn't be fully filled. FOK orders are fully filled or killed.",
        };
      }

      // GTC: order rests on the book until filled
      const orderId = crypto.randomUUID();
      const order: Order = {
        id: orderId,
        tokenId: req.tokenId,
        action: req.action,
        price: req.price,
        shares: req.shares,
        actualShares: req.shares,
        status: "live",
      };
      this._orders.set(orderId, order);
      return { orderId, status: "live", success: true, errorMsg: "" };
    });
  }

  async getOpenOrderIds(_conditionId: string): Promise<Set<string>> {
    await simulateDelay(this._clock, this._fixedDelayMs);
    const openIds = new Set<string>();
    for (const order of this._orders.values()) {
      if (order.status !== "live") continue;
      const book = this.getBook(order.tokenId);
      if (this._checkFill(order, book)) {
        this._orders.set(order.id, {
          ...order,
          status: "filled",
        });
        if (order.action === "buy") {
          this._balanceReadyAt.set(
            order.tokenId,
            this._clock.nowMs() + simBalanceDelayMs(),
          );
        }
      } else {
        openIds.add(order.id);
      }
    }
    return openIds;
  }

  async getOrderById(orderId: string): Promise<Order | null> {
    await simulateDelay(this._clock, this._fixedDelayMs);
    const order = this._orders.get(orderId);
    if (!order) return null;

    if (order.status === "live") {
      const book = this.getBook(order.tokenId);
      if (this._checkFill(order, book)) {
        const updated: Order = {
          ...order,
          status: "filled",
          actualShares: order.shares,
        };
        this._orders.set(orderId, updated);
        if (order.action === "buy") {
          this._balanceReadyAt.set(
            order.tokenId,
            this._clock.nowMs() + simBalanceDelayMs(),
          );
        }
        return updated;
      }
    }

    // Live = nothing matched yet (mirrors real CLOB where size_matched = 0 for unmatched orders)
    return {
      ...order,
      actualShares: order.status === "live" ? 0 : order.shares,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await simulateDelay(this._clock, this._fixedDelayMs);
    this._orders.delete(orderId);
  }

  async cancelOrders(orderIds: string[]): Promise<CancelOrderResponse> {
    await simulateDelay(this._clock, this._fixedDelayMs);
    const canceled: string[] = [];
    const not_canceled: Record<string, string> = {};
    for (const id of orderIds) {
      if (this._orders.has(id)) {
        this._orders.delete(id);
        canceled.push(id);
      } else {
        not_canceled[id] = "NOT_FOUND";
      }
    }
    for (const id of canceled) {
      const cb = this.cancelCallbacks.get(id);
      if (cb) {
        this.cancelCallbacks.delete(id);
        cb();
      }
    }
    return { canceled, not_canceled };
  }

  /** Re-insert a persisted order (for startup recovery). */
  restoreOrder(order: Order): void {
    this._orders.set(order.id, { ...order, status: "live" });
  }

  async getUSDCBalance(): Promise<number> {
    return Infinity;
  }

  async getAvailableShares(_tokenId: string): Promise<number> {
    return Infinity;
  }

  async updateUSDCBalance(): Promise<void> {}

  async updateAvailableShares(_tokenId: string): Promise<void> {}

  async getActivity(_type?: string): Promise<any[]> {
    return [];
  }

  async redeemPositions(
    _conditionId: string,
    _silent?: boolean,
  ): Promise<void> {}

  async wrapUSDC(_amount: bigint): Promise<void> {}
  async unwrapUSDC(_amount: bigint): Promise<void> {}
  async getTokenBalance(_token: `0x${string}`): Promise<bigint> {
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Real Polymarket CLOB client
// ---------------------------------------------------------------------------

function mapStatus(status: string): Order["status"] {
  switch (status.toLowerCase()) {
    case "matched":
      return "filled";
    case "live":
    case "unmatched":
      return "live";
    case "delayed":
      return "delayed";
    default:
      return "cancelled";
  }
}

export class PolymarketEarlyBirdClient implements EarlyBirdClient {
  clob!: ClobClient;
  private readonly _host = "https://clob.polymarket.com";
  private readonly _signer: Wallet;
  private readonly _funder: string | undefined;
  private readonly _signatureType: number;
  private readonly _builderConfig: BuilderConfig | null = null;
  private _creds: { key: string; secret: string; passphrase: string } | null =
    null;

  constructor() {
    const privateKey = Env.get("PRIVATE_KEY");
    if (!privateKey?.startsWith("0x")) {
      throw new Error("PRIVATE_KEY env var must be set (0x-prefixed)");
    }
    this._signer = new Wallet(privateKey);

    this._signatureType = Env.get("POLY_SIGNATURE_TYPE");
    if (![0, 1, 2, 3].includes(this._signatureType)) {
      throw new Error(
        `POLY_SIGNATURE_TYPE is required for production and must be set to 0, 1, 2, or 3.\n` +
          `0: EOA (standard wallet)\n` +
          `1: POLY_PROXY (existing Magic/Email proxy)\n` +
          `2: POLY_GNOSIS_SAFE (Safe wallet)\n` +
          `3: POLY_1271 (deposit-wallet / new API flow)`,
      );
    }

    const funderRaw = Env.get("POLY_FUNDER_ADDRESS");
    if (this._signatureType === 0) {
      this._funder = funderRaw || this._signer.address;
    } else {
      if (!funderRaw) {
        throw new Error(
          `POLY_FUNDER_ADDRESS is required for POLY_SIGNATURE_TYPE ${this._signatureType} (Proxy/Safe/1271).`,
        );
      }
      this._funder = funderRaw;
    }

    const builderKey = Env.get("BUILDER_KEY");
    const builderSecret = Env.get("BUILDER_SECRET");
    const builderPassphrase = Env.get("BUILDER_PASSPHRASE");

    const builderCount = [
      builderKey,
      builderSecret,
      builderPassphrase,
    ].filter(Boolean).length;

    if (builderCount > 0 && builderCount < 3) {
      throw new Error(
        "Partial BUILDER credentials detected. Set ALL three (BUILDER_KEY, BUILDER_SECRET, BUILDER_PASSPHRASE) or none.",
      );
    }

    if (builderCount === 3) {
      this._builderConfig = new BuilderConfig({
        localBuilderCreds: {
          key: builderKey,
          secret: builderSecret,
          passphrase: builderPassphrase,
        },
      });
    }
  }

  async init(): Promise<void> {
    const apiKeyNonceRaw = process.env.POLY_API_KEY_NONCE ?? "";
    const apiKeyNonce =
      apiKeyNonceRaw === "" ? undefined : Number.parseInt(apiKeyNonceRaw, 10);
    if (apiKeyNonce !== undefined && Number.isNaN(apiKeyNonce)) {
      throw new Error("POLY_API_KEY_NONCE must be an integer when set.");
    }

    let creds: { key: string; secret: string; passphrase: string };

    // Always derive CLOB API credentials from the owner signer. Static
    // POLY_API_* / BUILDER_* values are intentionally ignored for CLOB auth.
    const authClient = new ClobClient({
      host: this._host,
      chain: Chain.POLYGON,
      signer: this._signer,
    });
    creds = await authClient.createOrDeriveApiKey(apiKeyNonce || 1);
    this._creds = creds;

    // 2. Initialize the trading ClobClient with the EOA signer + Type 3 parameters
    this.clob = new ClobClient({
      host: this._host,
      chain: Chain.POLYGON,
      signer: this._signer,
      creds,
      signatureType: this._signatureType as any,
      funderAddress: this._funder,
    });
  }

  getApiCreds(): { key: string; secret: string; passphrase: string } {
    if (!this._creds)
      throw new Error("init() must be called before getApiCreds()");
    return this._creds;
  }

  // Optimized way of posting multiple orders without making many API calls
  async postMultipleOrders(
    orders: MultiOrderRequest[],
  ): Promise<PlacedOrder[]> {
    // Sign all orders in parallel, passing pre-fetched options to skip network calls
    // This is fully offline
    const signed = await Promise.all(
      orders.map((req) => {
        const userOrder: UserOrder = {
          tokenID: req.tokenId,
          price: req.price,
          size: req.shares,
          side: req.action === "buy" ? Side.BUY : Side.SELL,
        };

        const options: any = {
          tickSize: req.tickSize as TickSize,
          negRisk: req.negRisk,
        };

        if (req.orderType === "GTD" && req.expiration) {
          // Polymarket research shows a 60s security threshold for GTD
          (userOrder as any).expiration =
            Math.floor(Date.now() / 1000) + 60 + req.expiration;
        }

        return this.clob.orderBuilder.buildOrder(userOrder, options, 2);
      }),
    );

    const resp = await this.clob.postOrders(
      signed.map((order, i) => {
        let orderType = ClobOrderType.GTC;
        if (orders[i]!.orderType === "FOK") orderType = ClobOrderType.FOK;
        if (orders[i]!.orderType === "GTD") orderType = ClobOrderType.GTD;

        return {
          order,
          orderType,
        };
      }),
    );

    if (!Array.isArray(resp)) {
      const message =
        typeof resp === "object" && resp !== null && "error" in resp
          ? String((resp as { error?: unknown }).error)
          : `unexpected postOrders response: ${JSON.stringify(resp)}`;
      return orders.map(() => ({
        orderId: "",
        status: "failed",
        success: false,
        errorMsg: message,
      }));
    }

    return (resp as Array<{
      orderID: string;
      status: string;
      success: boolean;
      errorMsg: string;
    }>).map((r) => ({
      orderId: r.orderID,
      status: r.status,
      success: r.success,
      errorMsg: r.errorMsg,
    }));
  }

  async getOpenOrderIds(conditionId: string): Promise<Set<string>> {
    const orders = await this.clob.getOpenOrders({ market: conditionId });
    return new Set(orders.map((o) => o.id));
  }

  async getOrderById(orderId: string): Promise<Order | null> {
    try {
      const o = await this.clob.getOrder(orderId);
      if (!o || !o.id) return null;
      return {
        id: o.id,
        tokenId: o.asset_id,
        action: o.side === "BUY" ? "buy" : "sell",
        price: parseFloat(o.price),
        shares: parseFloat(o.original_size),
        actualShares: parseFloat(o.size_matched),
        status: mapStatus(o.status),
      };
    } catch {
      return null;
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.clob.cancelOrder({ orderID: orderId });
  }

  async cancelOrders(orderIds: string[]): Promise<CancelOrderResponse> {
    if (orderIds.length === 0) return { canceled: [], not_canceled: {} };
    const resp = await this.clob.cancelOrders(orderIds);
    return resp as CancelOrderResponse;
  }

  /** No-op for real client — orders already exist on the exchange. */
  restoreOrder(_order: Order): void {}

  /** Safety & Heartbeat */
  async sendHeartbeat(): Promise<void> {
    try {
      await (this.clob as any).postHeartbeat();
    } catch (err: any) {
      console.error(
        `[Heartbeat] Failed to send heartbeat: ${err.response?.data?.error || err.message}`,
      );
    }
  }

  async getUSDCBalance(): Promise<number> {
    try {
      const bal = await this.getTokenBalance(pUSD_ADDRESS);
      return Number(bal) / 1e6;
    } catch {
      return 0;
    }
  }

  async getAvailableShares(tokenId: string): Promise<number> {
    const resp = await this.clob.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    if (!resp || typeof resp === "string") return 0;
    return Number(resp.balance ?? 0) / 1e6;
  }

  async updateUSDCBalance(): Promise<void> {
    return await this.clob.updateBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
  }

  async updateAvailableShares(tokenId: string): Promise<void> {
    return await this.clob.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
  }

  /** Activity API */
  async getActivity(type?: string): Promise<any[]> {
    try {
      // The Data APIactivity endpoint is used for rebates and rewards.
      // ClobClient v2 might not have a direct wrapper, so we use the underlying axios/fetch if needed,
      // but usually getHistory or similar is available.
      if (typeof (this.clob as any).getActivity === "function") {
        return await (this.clob as any).getActivity({
          user: this._funder ?? this._signer.address,
          type,
        });
      }
      // Fallback: search for activity in trade history if specific activity endpoint not in SDK
      return [];
    } catch {
      return [];
    }
  }

  private _buildRelay(): RelayClient {
    if (!this._builderConfig) {
      throw new Error(
        "Relay operations (wrap/unwrap/redeem) require BUILDER_KEY, BUILDER_SECRET, and BUILDER_PASSPHRASE to be set.",
      );
    }
    const account = privateKeyToAccount(
      this._signer.privateKey as `0x${string}`,
    );
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(POLYGON_RPC),
    });
    return new RelayClient(
      RELAYER_URL,
      Chain.POLYGON,
      walletClient,
      this._builderConfig as any,
      RelayerTxType.PROXY,
    );
  }

  async getTokenBalance(token: `0x${string}`): Promise<bigint> {
    const owner = (this._funder ?? this._signer.address) as `0x${string}`;
    const publicClient = createPublicClient({
      chain: polygon,
      transport: http(POLYGON_RPC),
    });
    return await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
  }

  async wrapUSDC(amount: bigint): Promise<void> {
    const funder = (this._funder ?? this._signer.address) as `0x${string}`;
    const relay = this._buildRelay();
    const response = await relay.execute(
      [
        {
          to: USDC_ADDRESS as `0x${string}`,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [ONRAMP, amount],
          }),
          value: "0",
        },
        {
          to: ONRAMP,
          data: encodeFunctionData({
            abi: RAMP_ABI,
            functionName: "wrap",
            args: [USDC_ADDRESS as `0x${string}`, funder, amount],
          }),
          value: "0",
        },
      ],
      "wrap USDC.e -> pUSD",
    );
    const result = await response.wait();
    if (!result) throw new Error("Wrap relay failed");
  }

  async unwrapUSDC(amount: bigint): Promise<void> {
    const funder = (this._funder ?? this._signer.address) as `0x${string}`;
    const relay = this._buildRelay();
    const response = await relay.execute(
      [
        {
          to: pUSD_ADDRESS as `0x${string}`,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [OFFRAMP, amount],
          }),
          value: "0",
        },
        {
          to: OFFRAMP,
          data: encodeFunctionData({
            abi: RAMP_ABI,
            functionName: "unwrap",
            args: [USDC_ADDRESS as `0x${string}`, funder, amount],
          }),
          value: "0",
        },
      ],
      "unwrap pUSD -> USDC.e",
    );
    const result = await response.wait();
    if (!result) throw new Error("Unwrap relay failed");
  }

  async redeemPositions(conditionId: string, silent = false): Promise<void> {
    const relay = this._buildRelay();
    const data = encodeFunctionData({
      abi: CTF_REDEEM_ABI,
      functionName: "redeemPositions",
      args: [pUSD_ADDRESS, zeroHash, conditionId as `0x${string}`, [1n, 2n]],
    });

    const origLog = console.log;
    const origInfo = console.info;
    if (silent) {
      console.log = () => {};
      console.info = () => {};
    }
    try {
      const response = await relay.execute(
        [{ to: CTF_ADDRESS, data, value: "0" }],
        "redeem positions",
      );
      const result = await response.wait();
      if (!result)
        throw new Error(`Redemption relay failed for ${conditionId}`);
    } finally {
      if (silent) {
        console.log = origLog;
        console.info = origInfo;
      }
    }
  }
}
       console.info = origInfo;
      }
    }
  }
}
