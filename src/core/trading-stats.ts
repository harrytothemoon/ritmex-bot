// 交易统计数据类型定义
export interface TradingStats {
  // Maker 订单统计
  makerOrderCount: number;
  // Taker 订单统计  
  takerOrderCount: number;
  // 手续费总计
  totalFees: number;
  // 盈亏总计(已实现盈亏)
  totalPnl: number;
  // 成交量总计
  totalVolume: number;
  // 积分率 (每万点积分的耗损)
  pointsRate: number;
  // 开始时间
  startTime: number;
}

export interface HourlyStats extends TradingStats {
  // 小时统计的起始时间
  hourStartTime: number;
}

export interface TradingStatsSummary {
  // 总累计统计
  total: TradingStats;
  // 最近一小时统计
  hourly: HourlyStats;
}

export function createEmptyStats(startTime: number = Date.now()): TradingStats {
  return {
    makerOrderCount: 0,
    takerOrderCount: 0,
    totalFees: 0,
    totalPnl: 0,
    totalVolume: 0,
    pointsRate: 0,
    startTime,
  };
}

export function createEmptyHourlyStats(startTime: number = Date.now()): HourlyStats {
  return {
    ...createEmptyStats(startTime),
    hourStartTime: startTime,
  };
}

export function calculatePointsRate(fees: number, pnl: number, volume: number): number {
  if (volume <= 0) return 0;
  // 积分率 = (手续费 + 已实现盈亏的绝对损失) / 成交量 * 10000
  // 如果盈亏为负(亏损)，则计入耗损；如果为正(盈利)，则不计入耗损
  const loss = fees + (pnl < 0 ? Math.abs(pnl) : 0);
  return (loss / volume) * 10000;
}

export interface TradeData {
  isMaker: boolean;
  commission: number;  // 实际手续费金额
  realizedPnl: number; // 已实现盈亏
  volume: number;      // 成交金额
  price: number;       // 成交价格
  qty: number;         // 成交数量
  tradeId?: number;    // 交易ID
  timestamp: number;   // 交易时间
}

export function updateStatsWithRealTrade(
  stats: TradingStats,
  tradeData: TradeData
): void {
  if (tradeData.isMaker) {
    stats.makerOrderCount++;
  } else {
    stats.takerOrderCount++;
  }
  
  stats.totalFees += tradeData.commission;
  stats.totalPnl += tradeData.realizedPnl;
  stats.totalVolume += tradeData.volume;
  stats.pointsRate = calculatePointsRate(stats.totalFees, stats.totalPnl, stats.totalVolume);
}

export function shouldResetHourlyStats(hourlyStats: HourlyStats): boolean {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000; // 1小时的毫秒数
  return (now - hourlyStats.hourStartTime) >= oneHour;
}

export function resetHourlyStats(hourlyStats: HourlyStats): void {
  const now = Date.now();
  hourlyStats.makerOrderCount = 0;
  hourlyStats.takerOrderCount = 0;
  hourlyStats.totalFees = 0;
  hourlyStats.totalPnl = 0;
  hourlyStats.totalVolume = 0;
  hourlyStats.pointsRate = 0;
  hourlyStats.hourStartTime = now;
}

export function formatStatsForDisplay(stats: TradingStats): {
  makerCount: string;
  takerCount: string;
  fees: string;
  pnl: string;
  volume: string;
  pointsRate: string;
} {
  return {
    makerCount: stats.makerOrderCount.toString(),
    takerCount: stats.takerOrderCount.toString(),
    fees: stats.totalFees.toFixed(4),
    pnl: stats.totalPnl.toFixed(4),
    volume: (stats.totalVolume / 2).toFixed(2), // 几分 = 成交量/2
    pointsRate: stats.pointsRate.toFixed(2),
  };
}
