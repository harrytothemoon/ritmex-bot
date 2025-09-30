export interface TradingConfig {
  symbol: string;
  tradeAmount: number;
  lossLimit: number;
  trailingProfit: number;
  trailingCallbackRate: number;
  profitLockTriggerUsd: number;
  profitLockOffsetUsd: number;
  pollIntervalMs: number;
  maxLogEntries: number;
  klineInterval: string;
  maxCloseSlippagePct: number;
  priceTick: number; // price tick size, e.g. 0.1 for BTCUSDT
  qtyStep: number; // quantity step size, e.g. 0.001 BTC
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export const tradingConfig: TradingConfig = {
  symbol: process.env.TRADE_SYMBOL ?? "BTCUSDT",
  tradeAmount: parseNumber(process.env.TRADE_AMOUNT, 0.001),
  lossLimit: parseNumber(process.env.LOSS_LIMIT, 0.03),
  trailingProfit: parseNumber(process.env.TRAILING_PROFIT, 0.2),
  trailingCallbackRate: parseNumber(process.env.TRAILING_CALLBACK_RATE, 0.2),
  profitLockTriggerUsd: parseNumber(process.env.PROFIT_LOCK_TRIGGER_USD, 0.1),
  profitLockOffsetUsd: parseNumber(process.env.PROFIT_LOCK_OFFSET_USD, 0.05),
  pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 500),
  maxLogEntries: parseNumber(process.env.MAX_LOG_ENTRIES, 200),
  klineInterval: process.env.KLINE_INTERVAL ?? "1m",
  maxCloseSlippagePct: parseNumber(process.env.MAX_CLOSE_SLIPPAGE_PCT, 0.05),
  priceTick: parseNumber(process.env.PRICE_TICK, 0.1),
  qtyStep: parseNumber(process.env.QTY_STEP, 0.001),
};

export interface MakerConfig {
  symbol: string;
  tradeAmount: number;
  lossLimit: number;
  priceChaseThreshold: number;
  bidOffset: number;
  askOffset: number;
  refreshIntervalMs: number;
  maxLogEntries: number;
  maxCloseSlippagePct: number;
  priceTick: number;
}

export const makerConfig: MakerConfig = {
  symbol: process.env.TRADE_SYMBOL ?? "BTCUSDT",
  tradeAmount: parseNumber(process.env.TRADE_AMOUNT, 0.001),
  lossLimit: parseNumber(
    process.env.MAKER_LOSS_LIMIT,
    parseNumber(process.env.LOSS_LIMIT, 0.03)
  ),
  priceChaseThreshold: parseNumber(process.env.MAKER_PRICE_CHASE, 0.3),
  bidOffset: parseNumber(process.env.MAKER_BID_OFFSET, 0),
  askOffset: parseNumber(process.env.MAKER_ASK_OFFSET, 0),
  refreshIntervalMs: parseNumber(process.env.MAKER_REFRESH_INTERVAL_MS, 1500),
  maxLogEntries: parseNumber(process.env.MAKER_MAX_LOG_ENTRIES, 200),
  maxCloseSlippagePct: parseNumber(
    process.env.MAKER_MAX_CLOSE_SLIPPAGE_PCT ??
      process.env.MAX_CLOSE_SLIPPAGE_PCT,
    0.05
  ),
  priceTick: parseNumber(
    process.env.MAKER_PRICE_TICK ?? process.env.PRICE_TICK,
    0.1
  ),
};

export interface DepthImbalanceConfig {
  symbol: string;
  tradeAmount: number;
  lossLimit: number;
  minDepthQty: number; // 最小深度数量要求（例如 100 BTC）
  imbalanceRatio: number; // 不平衡倍数（例如 6 代表 6 倍）
  closeBalanceRatio: number; // 平仓阈值比例（例如 0.7 代表 70%）
  refreshIntervalMs: number;
  maxLogEntries: number;
  maxCloseSlippagePct: number;
}

export const depthImbalanceConfig: DepthImbalanceConfig = {
  symbol: process.env.TRADE_SYMBOL ?? "BTCUSDT",
  tradeAmount: parseNumber(process.env.TRADE_AMOUNT, 0.001),
  lossLimit: parseNumber(
    process.env.DEPTH_IMBALANCE_LOSS_LIMIT,
    parseNumber(process.env.LOSS_LIMIT, 0.03)
  ),
  minDepthQty: parseNumber(process.env.DEPTH_IMBALANCE_MIN_QTY, 100),
  imbalanceRatio: parseNumber(process.env.DEPTH_IMBALANCE_RATIO, 6),
  closeBalanceRatio: parseNumber(process.env.DEPTH_IMBALANCE_CLOSE_RATIO, 0.7),
  refreshIntervalMs: parseNumber(
    process.env.DEPTH_IMBALANCE_REFRESH_INTERVAL_MS,
    1000
  ),
  maxLogEntries: parseNumber(process.env.DEPTH_IMBALANCE_MAX_LOG_ENTRIES, 200),
  maxCloseSlippagePct: parseNumber(
    process.env.DEPTH_IMBALANCE_MAX_CLOSE_SLIPPAGE_PCT ??
      process.env.MAX_CLOSE_SLIPPAGE_PCT,
    0.05
  ),
};
