import { parseAtoms } from "./fixed.ts";

export type FixedBookLevel = { price: string; quantity: string };

export type CanonicalBook = {
  tokenId: string;
  sequence: string;
  continuity: "CONTINUOUS" | "GAP";
  sourceTimestampMs: number;
  ingestTimestampMs: number;
  bids: FixedBookLevel[];
  asks: FixedBookLevel[];
  originalPayloadHash: string;
};

export type TrustedTrade = {
  tradeId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: string;
  quantity: string;
  sourceTimestampMs: number;
  ingestTimestampMs: number;
  originalPayloadHash: string;
};

export class VenueBookService {
  private readonly books = new Map<string, CanonicalBook>();
  private readonly trades = new Map<string, TrustedTrade>();

  applySnapshot(book: CanonicalBook): void {
    this.validateBook(book);
    this.books.set(book.tokenId, {
      ...structuredClone(book),
      continuity: "CONTINUOUS",
    });
  }

  applyDelta(input: CanonicalBook): void {
    this.validateBook(input);
    const current = this.books.get(input.tokenId);
    if (!current) throw new Error(`book delta before snapshot for ${input.tokenId}`);
    const expected = BigInt(current.sequence) + 1n;
    const received = BigInt(input.sequence);
    if (received !== expected) {
      this.books.set(input.tokenId, {
        ...structuredClone(current),
        sequence: input.sequence,
        continuity: "GAP",
        ingestTimestampMs: input.ingestTimestampMs,
      });
      throw new Error(
        `book sequence gap for ${input.tokenId}: expected ${expected}, received ${received}`,
      );
    }
    this.books.set(input.tokenId, {
      ...structuredClone(input),
      continuity: "CONTINUOUS",
    });
  }

  recordTrustedTrade(trade: TrustedTrade): void {
    if (!trade.tradeId || !trade.side || parseAtoms(trade.quantity) <= 0n) {
      throw new Error("trade flow requires trusted side and positive size");
    }
    parseAtoms(trade.price);
    if (!this.trades.has(trade.tradeId)) {
      this.trades.set(trade.tradeId, structuredClone(trade));
    }
  }

  requireFreshContinuous(
    tokenId: string,
    decisionTimestampMs: number,
    maximumSourceAgeMs: number,
  ): CanonicalBook {
    const book = this.books.get(tokenId);
    if (!book) throw new Error(`missing venue book for ${tokenId}`);
    if (book.continuity !== "CONTINUOUS") {
      throw new Error(`venue book for ${tokenId} has a sequence gap`);
    }
    const age = decisionTimestampMs - book.sourceTimestampMs;
    if (age < 0 || age > maximumSourceAgeMs) {
      throw new Error(`venue book for ${tokenId} is stale`);
    }
    return structuredClone(book);
  }

  trustedTrades(): TrustedTrade[] {
    return [...this.trades.values()].map((trade) => structuredClone(trade));
  }

  private validateBook(book: CanonicalBook): void {
    BigInt(book.sequence);
    if (book.sourceTimestampMs > book.ingestTimestampMs + 5_000) {
      throw new Error("book source time is ahead of ingestion");
    }
    for (const level of [...book.bids, ...book.asks]) {
      if (parseAtoms(level.price) <= 0n || parseAtoms(level.quantity) <= 0n) {
        throw new Error("book levels must have positive price and quantity");
      }
    }
  }
}
