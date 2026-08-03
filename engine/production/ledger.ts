import type { AuthoritativeJournal, JournalRecord } from "./journal.ts";
import {
  assertNonNegativeAtoms,
  formatAtoms,
  minAtoms,
  multiplyAtoms,
  parseAtoms,
} from "./fixed.ts";

export type FillLot = {
  lotId: string;
  orderId: string;
  tradeId: string;
  marketId: string;
  tokenId: string;
  side: "BUY";
  price: string;
  quantity: string;
  remainingQuantity: string;
  fee: string;
  makerTaker: "MAKER" | "TAKER";
  sourceTimestampMs: number;
  ingestTimestampMs: number;
  settlementState: "OPEN" | "SOLD" | "SETTLED";
  costBasis: string;
  realizedProceeds: string;
  reconciliationEvidenceId?: string;
};

export type LedgerSnapshot = {
  cashBalance: string;
  availableCash: string;
  reservedBuyCash: string;
  pendingCash: string;
  tokenBalances: Record<string, string>;
  availableTokens: Record<string, string>;
  reservedSellTokens: Record<string, string>;
  pendingTokenAdjustments: Record<string, string>;
  realizedTradingPnl: string;
  settlementPnl: string;
  actualFees: string;
  verifiedRebates: string;
  externalDeposits: string;
  externalWithdrawals: string;
  lots: FillLot[];
};

type BuyReservation = {
  orderId: string;
  tokenId: string;
  limitPriceAtoms: bigint;
  remainingQuantityAtoms: bigint;
  remainingCashAtoms: bigint;
};

type SellReservation = {
  orderId: string;
  tokenId: string;
  remainingQuantityAtoms: bigint;
};

export type LedgerFill = {
  orderId: string;
  tradeId: string;
  marketId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: string;
  quantity: string;
  fee: string;
  makerTaker: "MAKER" | "TAKER";
  sourceTimestampMs: number;
  ingestTimestampMs: number;
  reconciliationEvidenceId?: string;
};

export class LotLedger {
  private cashAtoms: bigint;
  private pendingCashAtoms = 0n;
  private readonly tokenAtoms = new Map<string, bigint>();
  private readonly pendingTokenAtoms = new Map<string, bigint>();
  private readonly buyReservations = new Map<string, BuyReservation>();
  private readonly sellReservations = new Map<string, SellReservation>();
  private readonly fillLots: FillLot[] = [];
  private readonly seenTradeIds = new Set<string>();
  private realizedTradingPnlAtoms = 0n;
  private settlementPnlAtoms = 0n;
  private feesAtoms = 0n;
  private rebatesAtoms = 0n;
  private externalDepositsAtoms = 0n;
  private externalWithdrawalsAtoms = 0n;

  constructor(
    initialCash: string,
    private readonly journal: AuthoritativeJournal,
  ) {
    this.cashAtoms = parseAtoms(initialCash);
    assertNonNegativeAtoms("initial cash", this.cashAtoms);
  }

  static async open(
    journal: AuthoritativeJournal,
    initialCash?: string,
  ): Promise<LotLedger> {
    const records = journal.records();
    const initialized = records.find(
      (record) => record.kind === "ledger_initialized",
    );
    if (!initialized && initialCash === undefined) {
      throw new Error("initial cash is required for a new ledger");
    }
    const authoritativeInitialCash = initialized
      ? String(initialized.payload.initialCash)
      : initialCash!;
    const ledger = new LotLedger(authoritativeInitialCash, journal);
    if (!initialized) {
      await journal.append({
        kind: "ledger_initialized",
        aggregateId: "ledger",
        payload: { initialCash: authoritativeInitialCash },
      });
    } else {
      ledger.restoreFromJournal(records);
    }
    return ledger;
  }

  async reserveBuy(input: {
    orderId: string;
    tokenId: string;
    limitPrice: string;
    quantity: string;
    maximumFee: string;
  }): Promise<void> {
    this.assertOrderUnreserved(input.orderId);
    const price = parseAtoms(input.limitPrice);
    const quantity = parseAtoms(input.quantity);
    const maximumFee = parseAtoms(input.maximumFee);
    const required = multiplyAtoms(price, quantity) + maximumFee;
    assertNonNegativeAtoms("buy reservation", required);
    if (required > this.availableCashAtoms()) {
      throw new Error(
        `insufficient available cash: need ${formatAtoms(required)}, have ${formatAtoms(this.availableCashAtoms())}`,
      );
    }
    const reservation: BuyReservation = {
      orderId: input.orderId,
      tokenId: input.tokenId,
      limitPriceAtoms: price,
      remainingQuantityAtoms: quantity,
      remainingCashAtoms: required,
    };
    await this.journal.append({
      kind: "ledger_buy_reserved",
      aggregateId: input.orderId,
      payload: { ...input, reservedCash: formatAtoms(required) },
    });
    this.buyReservations.set(input.orderId, reservation);
  }

  async reserveSell(input: {
    orderId: string;
    tokenId: string;
    quantity: string;
  }): Promise<void> {
    this.assertOrderUnreserved(input.orderId);
    const quantity = parseAtoms(input.quantity);
    if (quantity > this.availableTokenAtoms(input.tokenId)) {
      throw new Error(
        `insufficient available token balance for ${input.tokenId}`,
      );
    }
    await this.journal.append({
      kind: "ledger_sell_reserved",
      aggregateId: input.orderId,
      payload: input,
    });
    this.sellReservations.set(input.orderId, {
      orderId: input.orderId,
      tokenId: input.tokenId,
      remainingQuantityAtoms: quantity,
    });
  }

  async releaseReservation(orderId: string, reason: string): Promise<void> {
    const buy = this.buyReservations.get(orderId);
    const sell = this.sellReservations.get(orderId);
    if (!buy && !sell) return;
    await this.journal.append({
      kind: "ledger_reservation_released",
      aggregateId: orderId,
      payload: {
        reason,
        releasedCash: formatAtoms(buy?.remainingCashAtoms ?? 0n),
        releasedTokens: formatAtoms(sell?.remainingQuantityAtoms ?? 0n),
        tokenId: buy?.tokenId ?? sell?.tokenId,
      },
    });
    this.buyReservations.delete(orderId);
    this.sellReservations.delete(orderId);
  }

  async applyFill(fill: LedgerFill): Promise<void> {
    if (this.seenTradeIds.has(fill.tradeId)) return;
    const price = parseAtoms(fill.price);
    const quantity = parseAtoms(fill.quantity);
    const fee = parseAtoms(fill.fee);
    if (price <= 0n || quantity <= 0n || fee < 0n) {
      throw new Error("fill price/quantity must be positive and fee non-negative");
    }

    if (fill.side === "BUY") {
      this.validateBuyFill(fill, quantity);
    } else {
      this.validateSellFill(fill, quantity);
    }

    await this.journal.append({
      kind: "ledger_fill_applied",
      aggregateId: fill.orderId,
      eventId: `trade:${fill.tradeId}`,
      occurredAtMs: fill.ingestTimestampMs,
      payload: fill,
    });

    if (fill.side === "BUY") {
      this.applyBuyFill(fill, price, quantity, fee);
    } else {
      this.applySellFill(fill, price, quantity, fee);
    }
    this.feesAtoms += fee;
    this.seenTradeIds.add(fill.tradeId);
  }

  async settleToken(input: {
    marketId: string;
    tokenId: string;
    payoutPerShare: string;
    evidenceId: string;
  }): Promise<void> {
    const payoutPerShare = parseAtoms(input.payoutPerShare);
    if (payoutPerShare !== 0n && payoutPerShare !== parseAtoms("1")) {
      throw new Error("binary settlement payout must be exactly 0 or 1");
    }
    const relevant = this.fillLots.filter(
      (lot) =>
        lot.marketId === input.marketId &&
        lot.tokenId === input.tokenId &&
        parseAtoms(lot.remainingQuantity) > 0n,
    );
    const quantity = relevant.reduce(
      (sum, lot) => sum + parseAtoms(lot.remainingQuantity),
      0n,
    );
    const allocatedCost = relevant.reduce(
      (sum, lot) => {
        const originalQuantity = parseAtoms(lot.quantity);
        const remaining = parseAtoms(lot.remainingQuantity);
        return (
          sum +
          (parseAtoms(lot.costBasis) * remaining) / originalQuantity
        );
      },
      0n,
    );
    const payout = multiplyAtoms(payoutPerShare, quantity);

    await this.journal.append({
      kind: "ledger_token_settled",
      aggregateId: `${input.marketId}:${input.tokenId}`,
      payload: {
        ...input,
        quantity: formatAtoms(quantity),
        payout: formatAtoms(payout),
        allocatedCost: formatAtoms(allocatedCost),
      },
    });

    this.cashAtoms += payout;
    this.tokenAtoms.set(
      input.tokenId,
      (this.tokenAtoms.get(input.tokenId) ?? 0n) - quantity,
    );
    this.settlementPnlAtoms += payout - allocatedCost;
    for (const lot of relevant) {
      lot.remainingQuantity = "0";
      lot.settlementState = "SETTLED";
      lot.reconciliationEvidenceId = input.evidenceId;
    }
  }

  async recordVerifiedRebate(input: {
    amount: string;
    evidenceId: string;
  }): Promise<void> {
    const amount = parseAtoms(input.amount);
    assertNonNegativeAtoms("rebate", amount);
    await this.journal.append({
      kind: "ledger_rebate_verified",
      aggregateId: input.evidenceId,
      payload: input,
    });
    this.rebatesAtoms += amount;
    this.cashAtoms += amount;
  }

  async recordExternalTransfer(input: {
    direction: "DEPOSIT" | "WITHDRAWAL";
    amount: string;
    evidenceId: string;
  }): Promise<void> {
    const amount = parseAtoms(input.amount);
    assertNonNegativeAtoms("external transfer", amount);
    if (input.direction === "WITHDRAWAL" && amount > this.cashAtoms) {
      throw new Error("external withdrawal exceeds cash balance");
    }
    await this.journal.append({
      kind: "ledger_external_transfer",
      aggregateId: input.evidenceId,
      payload: input,
    });
    if (input.direction === "DEPOSIT") {
      this.cashAtoms += amount;
      this.externalDepositsAtoms += amount;
    } else {
      this.cashAtoms -= amount;
      this.externalWithdrawalsAtoms += amount;
    }
  }

  setPendingAdjustments(input: {
    cash: string;
    tokens: Record<string, string>;
  }): void {
    this.pendingCashAtoms = parseAtoms(input.cash);
    this.pendingTokenAtoms.clear();
    for (const [tokenId, quantity] of Object.entries(input.tokens)) {
      this.pendingTokenAtoms.set(tokenId, parseAtoms(quantity));
    }
  }

  snapshot(): LedgerSnapshot {
    const reservedBuyCash = [...this.buyReservations.values()].reduce(
      (sum, reservation) => sum + reservation.remainingCashAtoms,
      0n,
    );
    const tokenIds = new Set([
      ...this.tokenAtoms.keys(),
      ...this.pendingTokenAtoms.keys(),
      ...[...this.sellReservations.values()].map((item) => item.tokenId),
    ]);
    const tokenBalances: Record<string, string> = {};
    const availableTokens: Record<string, string> = {};
    const reservedSellTokens: Record<string, string> = {};
    const pendingTokenAdjustments: Record<string, string> = {};
    for (const tokenId of [...tokenIds].sort()) {
      const total = this.tokenAtoms.get(tokenId) ?? 0n;
      const reserved = this.reservedSellTokenAtoms(tokenId);
      tokenBalances[tokenId] = formatAtoms(total);
      availableTokens[tokenId] = formatAtoms(total - reserved);
      reservedSellTokens[tokenId] = formatAtoms(reserved);
      pendingTokenAdjustments[tokenId] = formatAtoms(
        this.pendingTokenAtoms.get(tokenId) ?? 0n,
      );
    }
    return {
      cashBalance: formatAtoms(this.cashAtoms),
      availableCash: formatAtoms(this.availableCashAtoms()),
      reservedBuyCash: formatAtoms(reservedBuyCash),
      pendingCash: formatAtoms(this.pendingCashAtoms),
      tokenBalances,
      availableTokens,
      reservedSellTokens,
      pendingTokenAdjustments,
      realizedTradingPnl: formatAtoms(this.realizedTradingPnlAtoms),
      settlementPnl: formatAtoms(this.settlementPnlAtoms),
      actualFees: formatAtoms(this.feesAtoms),
      verifiedRebates: formatAtoms(this.rebatesAtoms),
      externalDeposits: formatAtoms(this.externalDepositsAtoms),
      externalWithdrawals: formatAtoms(this.externalWithdrawalsAtoms),
      lots: structuredClone(this.fillLots),
    };
  }

  private restoreFromJournal(records: readonly JournalRecord[]): void {
    for (const event of records) {
      switch (event.kind) {
        case "ledger_buy_reserved": {
          const payload = event.payload as {
            orderId: string;
            tokenId: string;
            limitPrice: string;
            quantity: string;
            reservedCash: string;
          };
          this.buyReservations.set(payload.orderId, {
            orderId: payload.orderId,
            tokenId: payload.tokenId,
            limitPriceAtoms: parseAtoms(payload.limitPrice),
            remainingQuantityAtoms: parseAtoms(payload.quantity),
            remainingCashAtoms: parseAtoms(payload.reservedCash),
          });
          break;
        }
        case "ledger_sell_reserved": {
          const payload = event.payload as {
            orderId: string;
            tokenId: string;
            quantity: string;
          };
          this.sellReservations.set(payload.orderId, {
            orderId: payload.orderId,
            tokenId: payload.tokenId,
            remainingQuantityAtoms: parseAtoms(payload.quantity),
          });
          break;
        }
        case "ledger_reservation_released":
          this.buyReservations.delete(event.aggregateId);
          this.sellReservations.delete(event.aggregateId);
          break;
        case "ledger_fill_applied": {
          const fill = event.payload as LedgerFill;
          if (this.seenTradeIds.has(fill.tradeId)) break;
          const price = parseAtoms(fill.price);
          const quantity = parseAtoms(fill.quantity);
          const fee = parseAtoms(fill.fee);
          if (fill.side === "BUY") {
            this.validateBuyFill(fill, quantity);
            this.applyBuyFill(fill, price, quantity, fee);
          } else {
            this.validateSellFill(fill, quantity);
            this.applySellFill(fill, price, quantity, fee);
          }
          this.feesAtoms += fee;
          this.seenTradeIds.add(fill.tradeId);
          break;
        }
        case "ledger_token_settled": {
          const payload = event.payload as {
            marketId: string;
            tokenId: string;
            evidenceId: string;
            quantity: string;
            payout: string;
            allocatedCost: string;
          };
          const quantity = parseAtoms(payload.quantity);
          this.cashAtoms += parseAtoms(payload.payout);
          this.tokenAtoms.set(
            payload.tokenId,
            (this.tokenAtoms.get(payload.tokenId) ?? 0n) - quantity,
          );
          this.settlementPnlAtoms +=
            parseAtoms(payload.payout) - parseAtoms(payload.allocatedCost);
          for (const lot of this.fillLots) {
            if (
              lot.marketId === payload.marketId &&
              lot.tokenId === payload.tokenId &&
              parseAtoms(lot.remainingQuantity) > 0n
            ) {
              lot.remainingQuantity = "0";
              lot.settlementState = "SETTLED";
              lot.reconciliationEvidenceId = payload.evidenceId;
            }
          }
          break;
        }
        case "ledger_rebate_verified": {
          const amount = parseAtoms(String(event.payload.amount));
          this.rebatesAtoms += amount;
          this.cashAtoms += amount;
          break;
        }
        case "ledger_external_transfer": {
          const amount = parseAtoms(String(event.payload.amount));
          if (event.payload.direction === "DEPOSIT") {
            this.cashAtoms += amount;
            this.externalDepositsAtoms += amount;
          } else {
            this.cashAtoms -= amount;
            this.externalWithdrawalsAtoms += amount;
          }
          break;
        }
      }
    }
  }

  private validateBuyFill(fill: LedgerFill, quantity: bigint): void {
    const reservation = this.buyReservations.get(fill.orderId);
    if (!reservation) throw new Error(`missing buy reservation ${fill.orderId}`);
    if (reservation.tokenId !== fill.tokenId) {
      throw new Error(`buy fill token mismatch for ${fill.orderId}`);
    }
    if (quantity > reservation.remainingQuantityAtoms) {
      throw new Error(`buy fill exceeds reserved remainder for ${fill.orderId}`);
    }
  }

  private validateSellFill(fill: LedgerFill, quantity: bigint): void {
    const reservation = this.sellReservations.get(fill.orderId);
    if (!reservation) throw new Error(`missing sell reservation ${fill.orderId}`);
    if (reservation.tokenId !== fill.tokenId) {
      throw new Error(`sell fill token mismatch for ${fill.orderId}`);
    }
    if (
      quantity > reservation.remainingQuantityAtoms ||
      quantity > (this.tokenAtoms.get(fill.tokenId) ?? 0n)
    ) {
      throw new Error(`sell fill exceeds held/reserved remainder for ${fill.orderId}`);
    }
  }

  private applyBuyFill(
    fill: LedgerFill,
    price: bigint,
    quantity: bigint,
    fee: bigint,
  ): void {
    const reservation = this.buyReservations.get(fill.orderId)!;
    const cost = multiplyAtoms(price, quantity);
    const debit = cost + fee;
    if (debit > reservation.remainingCashAtoms) {
      throw new Error(`buy fill debit exceeds reserved cash for ${fill.orderId}`);
    }
    this.cashAtoms -= debit;
    reservation.remainingQuantityAtoms -= quantity;
    reservation.remainingCashAtoms -= debit;
    this.tokenAtoms.set(
      fill.tokenId,
      (this.tokenAtoms.get(fill.tokenId) ?? 0n) + quantity,
    );
    this.fillLots.push({
      lotId: `lot:${fill.tradeId}`,
      orderId: fill.orderId,
      tradeId: fill.tradeId,
      marketId: fill.marketId,
      tokenId: fill.tokenId,
      side: "BUY",
      price: fill.price,
      quantity: fill.quantity,
      remainingQuantity: fill.quantity,
      fee: fill.fee,
      makerTaker: fill.makerTaker,
      sourceTimestampMs: fill.sourceTimestampMs,
      ingestTimestampMs: fill.ingestTimestampMs,
      settlementState: "OPEN",
      costBasis: formatAtoms(debit),
      realizedProceeds: "0",
      reconciliationEvidenceId: fill.reconciliationEvidenceId,
    });
  }

  private applySellFill(
    fill: LedgerFill,
    price: bigint,
    quantity: bigint,
    fee: bigint,
  ): void {
    const reservation = this.sellReservations.get(fill.orderId)!;
    const grossProceeds = multiplyAtoms(price, quantity);
    const netProceeds = grossProceeds - fee;
    let unallocated = quantity;
    let allocatedCost = 0n;
    for (const lot of this.fillLots) {
      if (lot.tokenId !== fill.tokenId || lot.settlementState !== "OPEN") continue;
      const remaining = parseAtoms(lot.remainingQuantity);
      if (remaining <= 0n) continue;
      const used = minAtoms(remaining, unallocated);
      const originalQuantity = parseAtoms(lot.quantity);
      const cost = (parseAtoms(lot.costBasis) * used) / originalQuantity;
      allocatedCost += cost;
      lot.remainingQuantity = formatAtoms(remaining - used);
      lot.realizedProceeds = formatAtoms(
        parseAtoms(lot.realizedProceeds) +
          (netProceeds * used) / quantity,
      );
      if (remaining === used) lot.settlementState = "SOLD";
      unallocated -= used;
      if (unallocated === 0n) break;
    }
    if (unallocated !== 0n) {
      throw new Error(`FIFO allocation failed for ${fill.tradeId}`);
    }
    reservation.remainingQuantityAtoms -= quantity;
    this.tokenAtoms.set(
      fill.tokenId,
      (this.tokenAtoms.get(fill.tokenId) ?? 0n) - quantity,
    );
    this.cashAtoms += netProceeds;
    this.realizedTradingPnlAtoms += netProceeds - allocatedCost;
  }

  private availableCashAtoms(): bigint {
    const reserved = [...this.buyReservations.values()].reduce(
      (sum, reservation) => sum + reservation.remainingCashAtoms,
      0n,
    );
    return this.cashAtoms - reserved;
  }

  private availableTokenAtoms(tokenId: string): bigint {
    return (
      (this.tokenAtoms.get(tokenId) ?? 0n) -
      this.reservedSellTokenAtoms(tokenId)
    );
  }

  private reservedSellTokenAtoms(tokenId: string): bigint {
    return [...this.sellReservations.values()]
      .filter((reservation) => reservation.tokenId === tokenId)
      .reduce(
        (sum, reservation) => sum + reservation.remainingQuantityAtoms,
        0n,
      );
  }

  private assertOrderUnreserved(orderId: string): void {
    if (this.buyReservations.has(orderId) || this.sellReservations.has(orderId)) {
      throw new Error(`order ${orderId} already has a ledger reservation`);
    }
  }
}
