import type {
  AsterAccountSnapshot,
  AsterOrder,
  AsterDepth,
  AsterTicker,
  AsterKline,
  CreateOrderParams,
} from "./types";

export interface AccountListener {
  (snapshot: AsterAccountSnapshot): void;
}

export interface OrderListener {
  (orders: AsterOrder[]): void;
}

export interface DepthListener {
  (depth: AsterDepth): void;
}

export interface TickerListener {
  (ticker: AsterTicker): void;
}

export interface KlineListener {
  (klines: AsterKline[]): void;
}

export interface TradeExecutionData {
  symbol: string;
  orderId: number;
  tradeId: number;
  price: number;        // 成交价格 (L)
  qty: number;          // 成交数量 (l)
  quoteQty: number;     // 成交金额 (计算得出)
  commission: number;   // 手续费 (n)
  commissionAsset: string; // 手续费资产 (N)
  isMaker: boolean;     // 是否为maker (m)
  realizedPnl: number;  // 已实现盈亏 (rp)
  side: string;         // 订单方向 (S)
  timestamp: number;   // 交易时间 (T)
}

export interface TradeListener {
  (trade: TradeExecutionData): void;
}

export interface ExchangeAdapter {
  readonly id: string;
  watchAccount(cb: AccountListener): void;
  watchOrders(cb: OrderListener): void;
  watchDepth(symbol: string, cb: DepthListener): void;
  watchTicker(symbol: string, cb: TickerListener): void;
  watchKlines(symbol: string, interval: string, cb: KlineListener): void;
  watchTrades(cb: TradeListener): void;
  createOrder(params: CreateOrderParams): Promise<AsterOrder>;
  cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void>;
  cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void>;
  cancelAllOrders(params: { symbol: string }): Promise<void>;
}
