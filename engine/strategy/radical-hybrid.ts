import type { Strategy, StrategyContext, OrderRequest } from "./types.ts";
import { Env } from "../../utils/config.ts";

export const radicalHybrid: Strategy = async (ctx: StrategyContext) => {
  const config = {
    mode: (ctx.strategyConfig.mode as string) ?? "hybrid",
    edgeThreshold: (ctx.strategyConfig.edgeThreshold as number) ?? 0.04,
    takerFee: (ctx.strategyConfig.takerFee as number) ?? 0.015,
    sharePct: (ctx.strategyConfig.sharePct as number) ?? 0.1,
    minShares: (ctx.strategyConfig.minShares as number) ?? 5,
    maxInventory: (ctx.strategyConfig.maxInventory as number) ?? 50,
    takeProfitEdge: (ctx.strategyConfig.takeProfitEdge as number) ?? 0.03,
    trailingStopMargin: (ctx.strategyConfig.trailingStopMargin as number) ?? 0.02,
    toxicJumpThreshold: (ctx.strategyConfig.toxicJumpThreshold as number) ?? 0.05,
    // --- FVM Pricing & Safeguards ---
    inventorySkew: (ctx.strategyConfig.inventorySkew as number) ?? 0.05,
    highVolExtraMargin: (ctx.strategyConfig.highVolExtraMargin as number) ?? 0.02,
    maxMakerBidPrice: (ctx.strategyConfig.maxMakerBidPrice as number) ?? 0.89,
    minCvd10s: (ctx.strategyConfig.minCvd10s as number) ?? -100,
    minImbalance: (ctx.strategyConfig.minImbalance as number) ?? -0.5,
    fallingKnifeWindow: (ctx.strategyConfig.fallingKnifeWindow as number) ?? 3,
    maxSpendAbs: (ctx.strategyConfig.maxSpendAbs as number) ?? 15.00,
    maxSigma: (ctx.strategyConfig.maxSigma as number) ?? 1.5,
    scaleOutProfitMargin: (ctx.strategyConfig.scaleOutProfitMargin as number) ?? 0.05,
    scaleOutInventoryPct: (ctx.strategyConfig.scaleOutInventoryPct as number) ?? 0.50,
    ...ctx.strategyConfig
  };

  const maxOrderShares = 15; // Safeguard to prevent Risk Gate rejections for oversized orders

  ctx.log(`[radical] Starting HFT strategy with Institutional Safeguards in ${config.mode} mode`, "cyan");

  const cleanupHandlers: Array<() => void> = [];
  const releaseLock = ctx.hold?.() ?? (() => {});
  cleanupHandlers.push(releaseLock);

  let lastProcessedTick = 0;
  
  // High water marks for trailing stops
  let highWaterMarkUp = 0;
  let highWaterMarkDown = 0;
  
  let scaleOutFiredUp = false;
  let scaleOutFiredDown = false;

  // Falling-knife state
  let consecutiveAdverseUp = 0;
  let consecutiveAdverseDown = 0;
  let sideBlockedUp = false;
  let sideBlockedDown = false;

  let lastExitAttemptUp = 0;
  let lastExitAttemptDown = 0;
  let lastEntryAttemptUp = 0;
  let lastEntryAttemptDown = 0;

  const flowAllowsSide = (side: "UP" | "DOWN"): boolean => {
    const flow = ctx.orderFlow?.latest() ?? null;
    if (!flow) return true;
    const isProd = Env.get("PROD");
    if (isProd && flow.source === "public_inferred" && flow.confidence === "low") return true;
    
    const imbalance = side === "UP" ? flow.imbalanceUp : flow.imbalanceDown;
    if (imbalance !== null && imbalance < config.minImbalance) return false;
    const cvd = side === "UP" ? flow.cvd10s.up - flow.cvd10s.down : flow.cvd10s.down - flow.cvd10s.up;
    return cvd >= config.minCvd10s;
  };

  const tick = async () => {
    const now = ctx.clock.nowMs();
    if (now - lastProcessedTick < 10) return; // Enforce 10ms heartbeat
    lastProcessedTick = now;

    const quant = ctx.quant?.latest();
    if (!quant || quant.probabilityUp === null) return;
    const probUp = quant.probabilityUp;
    const probDown = 1 - probUp;
    
    const aggregate = ctx.predictive?.aggregate?.latest() ?? null;

    // HYGIENE FILTER: Detect predictive disagreement
    const skipEntries = aggregate?.disagreement === true;
    if (skipEntries) {
        const activeEntryMakers = ctx.pendingOrders.filter(o => o.orderType === "GTC" && o.action === "buy");
        if (activeEntryMakers.length > 0) {
            ctx.log("[radical] Hygiene: Predictive disagreement. Pulling active quotes to prevent toxic fills.", "yellow");
            ctx.cancelOrders(activeEntryMakers.map(o => o.orderId));
        }
    }

    const sigma = quant.sigma ?? 0;
    const isHighVol = (quant as any).volatilityRegime === "high_vol";
    const jumpDetected = (quant as any).jumpDetected;

    // VOLATILITY CUTOFF
    if (sigma > config.maxSigma || jumpDetected) {
        if (!skipEntries) { // If not already skipping entries
            const activeEntryMakers = ctx.pendingOrders.filter(o => o.orderType === "GTC" && o.action === "buy");
            if (activeEntryMakers.length > 0) {
                ctx.log(`[radical] Safeguard: High volatility (Sigma=${sigma.toFixed(2)}). Pulling quotes.`, "yellow");
                ctx.cancelOrders(activeEntryMakers.map(o => o.orderId));
            }
        }
    }
    const blocksEntries = skipEntries || sigma > config.maxSigma || jumpDetected;

    const upTokenId = ctx.clobTokenIds[0];
    const downTokenId = ctx.clobTokenIds[1];

    const upBid = ctx.orderBook.bestBidPrice("UP") ?? 0;
    const upAsk = ctx.orderBook.bestAskPrice("UP") ?? 1;
    const downBid = ctx.orderBook.bestBidPrice("DOWN") ?? 0;
    const downAsk = ctx.orderBook.bestAskPrice("DOWN") ?? 1;

    // --- 1. VWAP & INVENTORY TRACKING ---
    let inventoryUp = 0;
    let inventoryDown = 0;
    let totalSpendUp = 0;
    let totalSpendDown = 0;

    for (const h of ctx.orderHistory) {
        if (h.tokenId === upTokenId) {
            if (h.action === "buy") {
                inventoryUp += h.shares;
                totalSpendUp += h.price * h.shares;
            } else {
                const vwap = inventoryUp > 0 ? totalSpendUp / inventoryUp : 0;
                inventoryUp = Math.max(0, inventoryUp - h.shares);
                totalSpendUp = inventoryUp * vwap;
            }
        } else if (h.tokenId === downTokenId) {
            if (h.action === "buy") {
                inventoryDown += h.shares;
                totalSpendDown += h.price * h.shares;
            } else {
                const vwap = inventoryDown > 0 ? totalSpendDown / inventoryDown : 0;
                inventoryDown = Math.max(0, inventoryDown - h.shares);
                totalSpendDown = inventoryDown * vwap;
            }
        }
    }

    const vwapUp = inventoryUp > 0 ? totalSpendUp / inventoryUp : 0;
    const vwapDown = inventoryDown > 0 ? totalSpendDown / inventoryDown : 0;

    // Reset High Water Marks if inventory is empty
    if (inventoryUp <= 0) {
        highWaterMarkUp = 0;
        scaleOutFiredUp = false;
    } else {
        highWaterMarkUp = Math.max(highWaterMarkUp, probUp, upBid);
    }

    if (inventoryDown <= 0) {
        highWaterMarkDown = 0;
        scaleOutFiredDown = false;
    } else {
        highWaterMarkDown = Math.max(highWaterMarkDown, probDown, downBid);
    }

    // --- 2. SOPHISTICATED EXITS ---
    let exitingUp = false;
    let exitingDown = false;
    const hasTakerExit = (tokenId: string) => ctx.pendingOrders.some(o => o.tokenId === tokenId && o.orderType === "FOK" && o.action === "sell");

    const nowMs = ctx.clock.nowMs();

    if (inventoryUp > 0 && !hasTakerExit(upTokenId) && nowMs - lastExitAttemptUp > 1000) {
        // Toxic Jump Panic Dump
        if (probUp < vwapUp - config.toxicJumpThreshold) {
            exitingUp = true;
            lastExitAttemptUp = nowMs;
            ctx.log(`[radical] TOXIC JUMP on UP. VWAP=${vwapUp.toFixed(3)}, Prob=${probUp.toFixed(3)}. Dumping ${inventoryUp} shares.`, "red");
            placeTakerOrder(upTokenId, "sell", Math.max(0.01, upBid - 0.01), Math.min(inventoryUp, maxOrderShares));
        }
        // Trailing Stop Exit
        else if (vwapUp > 0 && upBid - vwapUp >= 0.05) { // Needs 5c profit to arm
            const drawdown = highWaterMarkUp - upBid;
            if (drawdown > config.trailingStopMargin) {
                exitingUp = true;
                lastExitAttemptUp = nowMs;
                ctx.log(`[radical] TRAILING STOP on UP. Drawdown=${drawdown.toFixed(3)}. Dumping ${inventoryUp} shares.`, "green");
                placeTakerOrder(upTokenId, "sell", Math.max(0.01, upBid - 0.01), Math.min(inventoryUp, maxOrderShares));
            }
        }
        // Scale-Out Partial Exit
        if (!exitingUp && !scaleOutFiredUp && upBid >= vwapUp + config.scaleOutProfitMargin) {
            const scaleOutShares = Math.max(1, Math.floor(inventoryUp * config.scaleOutInventoryPct));
            if (scaleOutShares >= 1) {
                scaleOutFiredUp = true;
                lastExitAttemptUp = nowMs;
                ctx.log(`[radical] SCALE-OUT UP. Profit Target Hit. Selling ${scaleOutShares} shares at ${upBid}`, "green");
                placeTakerOrder(upTokenId, "sell", Math.max(0.01, upBid - 0.01), Math.min(scaleOutShares, maxOrderShares));
            }
        }
    }

    if (inventoryDown > 0 && !hasTakerExit(downTokenId) && nowMs - lastExitAttemptDown > 1000) {
        if (probDown < vwapDown - config.toxicJumpThreshold) {
            exitingDown = true;
            lastExitAttemptDown = nowMs;
            ctx.log(`[radical] TOXIC JUMP on DOWN. VWAP=${vwapDown.toFixed(3)}, Prob=${probDown.toFixed(3)}. Dumping ${inventoryDown} shares.`, "red");
            placeTakerOrder(downTokenId, "sell", Math.max(0.01, downBid - 0.01), Math.min(inventoryDown, maxOrderShares));
        }
        else if (vwapDown > 0 && downBid - vwapDown >= 0.05) {
            const drawdown = highWaterMarkDown - downBid;
            if (drawdown > config.trailingStopMargin) {
                exitingDown = true;
                lastExitAttemptDown = nowMs;
                ctx.log(`[radical] TRAILING STOP on DOWN. Drawdown=${drawdown.toFixed(3)}. Dumping ${inventoryDown} shares.`, "green");
                placeTakerOrder(downTokenId, "sell", Math.max(0.01, downBid - 0.01), Math.min(inventoryDown, maxOrderShares));
            }
        }
        if (!exitingDown && !scaleOutFiredDown && downBid >= vwapDown + config.scaleOutProfitMargin) {
            const scaleOutShares = Math.max(1, Math.floor(inventoryDown * config.scaleOutInventoryPct));
            if (scaleOutShares >= 1) {
                scaleOutFiredDown = true;
                lastExitAttemptDown = nowMs;
                ctx.log(`[radical] SCALE-OUT DOWN. Profit Target Hit. Selling ${scaleOutShares} shares at ${downBid}`, "green");
                placeTakerOrder(downTokenId, "sell", Math.max(0.01, downBid - 0.01), Math.min(scaleOutShares, maxOrderShares));
            }
        }
    }

    // --- MICRO-CANCEL (MAKER SAFETY) ---
    for (const order of ctx.pendingOrders) {
        if (order.orderType !== "GTC" || order.action !== "buy") continue;
        const currentProb = order.tokenId === upTokenId ? probUp : probDown;
        if (currentProb - order.price < 0) {
            ctx.log(`[radical] Toxic flow detected! Micro-cancelling ${order.action} ${order.price}`, "red");
            ctx.cancelOrders([order.orderId]);
        }
    }

    // --- ENTRY LOGIC ---
    if (!blocksEntries) {
        const remainingSecs = (ctx.slotEndMs - ctx.clock.nowMs()) / 1000;
        const timeFraction = Math.max(0, Math.min(1, remainingSecs / 300));
        
        // 1. Avellaneda Inventory Skew
        const skewUp = (inventoryUp / config.maxInventory) * config.inventorySkew * Math.max(0.25, timeFraction);
        const skewDown = (inventoryDown / config.maxInventory) * config.inventorySkew * Math.max(0.25, timeFraction);
        const adjustedProbUp = Math.max(0.01, Math.min(0.99, probUp - skewUp));
        const adjustedProbDown = Math.max(0.01, Math.min(0.99, probDown - skewDown));
        
        // 2. Volatility Buffer
        const volBuffer = Math.min(0.05, Math.max(0, sigma) * Math.sqrt(Math.max(remainingSecs, 1) / 31536000) * 2);
        const quoteMargin = config.edgeThreshold + volBuffer + (isHighVol ? config.highVolExtraMargin : 0);

        // 3. Quote Bounding
        let rawBidUp = parseFloat((adjustedProbUp - quoteMargin).toFixed(2));
        let rawBidDown = parseFloat((adjustedProbDown - quoteMargin).toFixed(2));
        if (rawBidUp <= 0.01 || rawBidUp > config.maxMakerBidPrice) rawBidUp = NaN;
        if (rawBidDown <= 0.01 || rawBidDown > config.maxMakerBidPrice) rawBidDown = NaN;

        const allowUpFlow = flowAllowsSide("UP") && !sideBlockedUp;
        const allowDownFlow = flowAllowsSide("DOWN") && !sideBlockedDown;

        const calcEdgeMultiplier = (edge: number) => Math.min(2.0, Math.max(0.5, edge / config.edgeThreshold));

        // TAKER PREDATOR
        if (config.mode === "hybrid" || config.mode === "taker") {
            const upTakerEdge = adjustedProbUp - upAsk;
            if (allowUpFlow && !exitingUp && inventoryUp < config.maxInventory && upTakerEdge > config.takerFee + quoteMargin && upAsk <= config.maxMakerBidPrice && nowMs - lastEntryAttemptUp > 1000) {
                const shares = calculateTargetShares(upAsk, calcEdgeMultiplier(upTakerEdge));
                if (shares > 0) {
                    lastEntryAttemptUp = nowMs;
                    ctx.log(`[predator] Snatching UP at ${upAsk} (Edge: ${upTakerEdge.toFixed(3)})`, "green");
                    placeTakerOrder(upTokenId, "buy", upAsk, shares, "UP");
                }
            }
            const downTakerEdge = adjustedProbDown - downAsk;
            if (allowDownFlow && !exitingDown && inventoryDown < config.maxInventory && downTakerEdge > config.takerFee + quoteMargin && downAsk <= config.maxMakerBidPrice && nowMs - lastEntryAttemptDown > 1000) {
                const shares = calculateTargetShares(downAsk, calcEdgeMultiplier(downTakerEdge));
                if (shares > 0) {
                    lastEntryAttemptDown = nowMs;
                    ctx.log(`[predator] Snatching DOWN at ${downAsk} (Edge: ${downTakerEdge.toFixed(3)})`, "green");
                    placeTakerOrder(downTokenId, "buy", downAsk, shares, "DOWN");
                }
            }
        }

        // MAKER PROVIDER
        if (config.mode === "hybrid" || config.mode === "maker") {
            const activeMakerCount = ctx.pendingOrders.filter(o => o.orderType === "GTC" && o.action === "buy").length;
            if (activeMakerCount < 2) {
                if (allowUpFlow && !exitingUp && inventoryUp < config.maxInventory && Number.isFinite(rawBidUp) && !isAlreadyQuoting(upTokenId, "buy") && nowMs - lastEntryAttemptUp > 1000) {
                    const safeUpPrice = Math.max(0.01, Math.min(rawBidUp, upAsk - 0.01));
                    const edge = adjustedProbUp - safeUpPrice;
                    const shares = calculateTargetShares(safeUpPrice, calcEdgeMultiplier(edge));
                    if (shares > 0) {
                        lastEntryAttemptUp = nowMs;
                        placeMakerOrder(upTokenId, "buy", safeUpPrice, shares);
                    }
                }
                if (allowDownFlow && !exitingDown && inventoryDown < config.maxInventory && Number.isFinite(rawBidDown) && !isAlreadyQuoting(downTokenId, "buy") && nowMs - lastEntryAttemptDown > 1000) {
                    const safeDownPrice = Math.max(0.01, Math.min(rawBidDown, downAsk - 0.01));
                    const edge = adjustedProbDown - safeDownPrice;
                    const shares = calculateTargetShares(safeDownPrice, calcEdgeMultiplier(edge));
                    if (shares > 0) {
                        lastEntryAttemptDown = nowMs;
                        placeMakerOrder(downTokenId, "buy", safeDownPrice, shares);
                    }
                }
            }
        }
    }
  };

  const isAlreadyQuoting = (tokenId: string, action: "buy" | "sell") => {
    return ctx.pendingOrders.some(o => o.tokenId === tokenId && o.orderType === "GTC" && o.action === action);
  };

  const calculateTargetShares = (price: number, edgeMultiplier: number) => {
      const balance = ctx.walletBalanceUsd;
      let targetNotional = balance > 0 ? balance * config.sharePct : 0;
      targetNotional *= edgeMultiplier;
      targetNotional = Math.min(targetNotional, config.maxSpendAbs); // Hard Spend Cap
      
      if (targetNotional <= 0 || price <= 0) return 0;
      return Math.min(maxOrderShares, Math.max(config.minShares, Math.floor(targetNotional / price)));
  };

  const checkFallingKnifeAdverse = (side: "UP" | "DOWN", fillPrice: number) => {
      const bestBid = ctx.orderBook.bestBidPrice(side);
      const bestAsk = ctx.orderBook.bestAskPrice(side);
      if (bestBid === null || bestAsk === null) return false;
      const mid = (bestBid + bestAsk) / 2;
      return mid < fillPrice;
  };

  const placeTakerOrder = (tokenId: string, action: "buy" | "sell", price: number, shares: number, side?: "UP"|"DOWN") => {
    if (shares < 1) return;
    if (ctx.pendingOrders.some(o => o.tokenId === tokenId && o.orderType === "FOK" && o.action === action)) return; 

    ctx.postOrders([{
        req: { tokenId, action, price, shares, orderType: "FOK" },
        expireAtMs: ctx.clock.nowMs() + 1000,
        onFilled: (s) => {
            ctx.log(`[taker] ${action.toUpperCase()} Filled ${s} shares at ${price}`, "green");
            if (action === "buy" && side) {
                const isAdverse = checkFallingKnifeAdverse(side, price);
                if (side === "UP") {
                    if (isAdverse) consecutiveAdverseUp++; else consecutiveAdverseUp = 0;
                    if (consecutiveAdverseUp >= config.fallingKnifeWindow) sideBlockedUp = true;
                } else {
                    if (isAdverse) consecutiveAdverseDown++; else consecutiveAdverseDown = 0;
                    if (consecutiveAdverseDown >= config.fallingKnifeWindow) sideBlockedDown = true;
                }
            }
        },
        onFailed: () => {}
    }]);
  };

  const placeMakerOrder = (tokenId: string, action: "buy" | "sell", price: number, shares: number) => {
    if (shares < 1) return;
    ctx.postOrders([{
        req: { tokenId, action, price, shares, orderType: "GTC" },
        expireAtMs: ctx.clock.nowMs() + 30000,
        onFilled: (s) => {
            ctx.log(`[maker] ${action.toUpperCase()} Filled ${s} shares at ${price}`, "green");
            // Maker buys are generally safe limit orders, but we still track adverse fills if the market plows through them
            const side = tokenId === ctx.clobTokenIds[0] ? "UP" : "DOWN";
            if (action === "buy") {
                const isAdverse = checkFallingKnifeAdverse(side, price);
                if (side === "UP") {
                    if (isAdverse) consecutiveAdverseUp++; else consecutiveAdverseUp = 0;
                    if (consecutiveAdverseUp >= config.fallingKnifeWindow) {
                        sideBlockedUp = true;
                        ctx.log(`[radical] FALLING KNIFE BLOCK TRIGGERED on UP.`, "yellow");
                    }
                } else {
                    if (isAdverse) consecutiveAdverseDown++; else consecutiveAdverseDown = 0;
                    if (consecutiveAdverseDown >= config.fallingKnifeWindow) {
                        sideBlockedDown = true;
                        ctx.log(`[radical] FALLING KNIFE BLOCK TRIGGERED on DOWN.`, "yellow");
                    }
                }
            }
        },
        onFailed: () => {}
    }]);
  };

  const interval = ctx.clock.setInterval(tick, 10);
  cleanupHandlers.push(() => ctx.clock.clearInterval(interval));

  return () => {
    ctx.log("[radical] Strategy stopping", "cyan");
    for (const h of cleanupHandlers) h();
  };
};
