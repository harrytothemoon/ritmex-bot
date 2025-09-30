import type { MakerConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterOrder,
  AsterTicker,
} from "../exchanges/types";
import { roundDownToTick } from "../utils/math";
import { createTradeLog, type TradeLogEntry } from "../state/trade-log";
import { isUnknownOrderError, isRateLimitError } from "../utils/errors";
import { getPosition, type PositionSnapshot } from "../utils/strategy";
import { computePositionPnl } from "../utils/pnl";
import { getTopPrices, getMidOrLast } from "../utils/price";
import { shouldStopLoss } from "../utils/risk";
import { marketClose, placeOrder, unlockOperating } from "./order-coordinator";
import type {
  OrderLockMap,
  OrderPendingMap,
  OrderTimerMap,
} from "./order-coordinator";

export interface MakerEngineSnapshot {
  accountSnapshot: AsterAccountSnapshot | null;
  depthSnapshot: AsterDepth | null;
  tickerSnapshot: AsterTicker | null;
  openOrders: AsterOrder[];
  desiredOrders: DesiredOrder[];
  sessionQuoteVolume: number;
  accountUnrealized: number;
  tradeLog: Array<{ type: string; timestamp: number; message: string }>;
  lastUpdated: number;
  ready: boolean;
  symbol: string;
  topBid: number | null;
  topAsk: number | null;
  spread: number;
  position: { positionAmt: number; entryPrice: number; side: string };
  pnl: number;
  sessionVolume: number;
  // 交易统计信息
  tradingStats: TradingStatsSummary;
}

import { makeOrderPlan } from "./lib/order-plan";
import { safeCancelOrder } from "./lib/orders";
import { RateLimitController } from "./lib/rate-limit";
import {
  type TradingStatsSummary,
  createEmptyStats,
  createEmptyHourlyStats,
  updateStatsWithRealTrade,
  shouldResetHourlyStats,
  resetHourlyStats,
  type TradeData,
} from "./trading-stats";
import type { TradeExecutionData } from "../exchanges/adapter";

interface DesiredOrder {
  side: "BUY" | "SELL";
  price: number;
  amount: number;
  reduceOnly: boolean;
}

export interface MakerEngineSnapshot {
  ready: boolean;
  symbol: string;
  topBid: number | null;
  topAsk: number | null;
  spread: number | null;
  position: PositionSnapshot;
  pnl: number;
  accountUnrealized: number;
  sessionVolume: number;
  openOrders: AsterOrder[];
  desiredOrders: DesiredOrder[];
  tradeLog: TradeLogEntry[];
  lastUpdated: number | null;
  // 交易统计信息
  tradingStats: TradingStatsSummary;
}

type MakerEvent = "update";
type MakerListener = (snapshot: MakerEngineSnapshot) => void;

const EPS = 1e-5;

export class MakerEngine {
  private accountSnapshot: AsterAccountSnapshot | null = null;
  private depthSnapshot: AsterDepth | null = null;
  private tickerSnapshot: AsterTicker | null = null;
  private openOrders: AsterOrder[] = [];

  private readonly locks: OrderLockMap = {};
  private readonly timers: OrderTimerMap = {};
  private readonly pending: OrderPendingMap = {};
  private readonly pendingCancelOrders = new Set<number>();

  private readonly tradeLog: ReturnType<typeof createTradeLog>;
  private readonly listeners = new Map<MakerEvent, Set<MakerListener>>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private desiredOrders: DesiredOrder[] = [];
  private accountUnrealized = 0;
  private sessionQuoteVolume = 0;
  private prevPositionAmt = 0;
  private initializedPosition = false;
  private initialOrderSnapshotReady = false;
  private initialOrderResetDone = false;
  private entryPricePendingLogged = false;
  private readonly rateLimit: RateLimitController;

  // 交易统计数据
  private tradingStats: TradingStatsSummary;
  private startTime: number = 0;

  constructor(
    private readonly config: MakerConfig,
    private readonly exchange: ExchangeAdapter
  ) {
    this.tradeLog = createTradeLog(this.config.maxLogEntries);
    this.rateLimit = new RateLimitController(
      this.config.refreshIntervalMs,
      (type, detail) => this.tradeLog.push(type, detail)
    );

    // 初始化交易统计数据
    const now = Date.now();
    this.tradingStats = {
      total: createEmptyStats(now),
      hourly: createEmptyHourlyStats(now),
    };

    this.bootstrap();
  }

  start(): void {
    if (this.timer) return;

    this.startTime = Date.now();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.refreshIntervalMs);

    // 发送启动通知
    void this.sendStartNotification();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;

      // 发送停止通知
      void this.sendStopNotification();
    }
  }

  on(event: MakerEvent, handler: MakerListener): void {
    const handlers = this.listeners.get(event) ?? new Set<MakerListener>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  off(event: MakerEvent, handler: MakerListener): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.listeners.delete(event);
    }
  }

  getSnapshot(): MakerEngineSnapshot {
    // 检查并重置小时统计数据
    if (shouldResetHourlyStats(this.tradingStats.hourly)) {
      resetHourlyStats(
        this.tradingStats.hourly,
        this.tradingStats.total,
        this.config.symbol
      );
    }

    const { topBid, topAsk } = getTopPrices(this.depthSnapshot);
    const ready =
      this.accountSnapshot !== null &&
      this.depthSnapshot !== null &&
      this.initialOrderSnapshotReady;
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    const spread = topBid && topAsk ? topAsk - topBid : 0;
    const pnl = computePositionPnl(position, this.tickerSnapshot);

    return {
      accountSnapshot: this.accountSnapshot,
      depthSnapshot: this.depthSnapshot,
      tickerSnapshot: this.tickerSnapshot,
      openOrders: [...this.openOrders],
      desiredOrders: [...this.desiredOrders],
      sessionQuoteVolume: this.sessionQuoteVolume,
      accountUnrealized: this.accountUnrealized,
      tradeLog: this.tradeLog.all().map((entry) => ({
        type: entry.type,
        timestamp: entry.eventTime || Date.now(),
        message: entry.detail,
      })),
      lastUpdated: Date.now(),
      ready,
      symbol: this.config.symbol,
      topBid,
      topAsk,
      spread,
      position: {
        positionAmt: position.positionAmt,
        entryPrice: position.entryPrice,
        side: position.positionSide || "BOTH",
      },
      pnl,
      sessionVolume: this.sessionQuoteVolume,
      tradingStats: {
        total: { ...this.tradingStats.total },
        hourly: { ...this.tradingStats.hourly },
      },
    };
  }

  private bootstrap(): void {
    try {
      this.exchange.watchAccount((snapshot) => {
        try {
          this.accountSnapshot = snapshot;
          const totalUnrealized = Number(snapshot.totalUnrealizedProfit ?? "0");
          if (Number.isFinite(totalUnrealized)) {
            this.accountUnrealized = totalUnrealized;
          }
          const position = getPosition(snapshot, this.config.symbol);
          this.updateSessionVolume(position);
          this.emitUpdate();
        } catch (err) {
          this.tradeLog.push("error", `账户推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅账户失败: ${String(err)}`);
    }

    try {
      this.exchange.watchOrders((orders) => {
        try {
          this.syncLocksWithOrders(orders);
          this.openOrders = Array.isArray(orders)
            ? orders.filter(
                (order) =>
                  order.type !== "MARKET" && order.symbol === this.config.symbol
              )
            : [];
          const currentIds = new Set(
            this.openOrders.map((order) => order.orderId)
          );
          for (const id of Array.from(this.pendingCancelOrders)) {
            if (!currentIds.has(id)) {
              this.pendingCancelOrders.delete(id);
            }
          }
          this.initialOrderSnapshotReady = true;
          this.emitUpdate();
        } catch (err) {
          this.tradeLog.push("error", `订单推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅订单失败: ${String(err)}`);
    }

    // 监听真实交易数据
    try {
      this.exchange.watchTrades((tradeData) => {
        try {
          // 只处理当前交易对的交易
          if (tradeData.symbol === this.config.symbol) {
            this.handleRealTrade(tradeData);
          }
        } catch (err) {
          this.tradeLog.push("error", `交易数据处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅交易数据失败: ${String(err)}`);
    }

    try {
      this.exchange.watchDepth(this.config.symbol, (depth) => {
        try {
          this.depthSnapshot = depth;
          this.emitUpdate();
        } catch (err) {
          this.tradeLog.push("error", `深度推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅深度失败: ${String(err)}`);
    }

    try {
      this.exchange.watchTicker(this.config.symbol, (ticker) => {
        try {
          this.tickerSnapshot = ticker;
          this.emitUpdate();
        } catch (err) {
          this.tradeLog.push("error", `价格推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅Ticker失败: ${String(err)}`);
    }

    // Maker strategy does not consume klines, but subscribe to keep parity with other modules
    try {
      this.exchange.watchKlines(this.config.symbol, "1m", () => {
        try {
          /* no-op */
        } catch (err) {
          this.tradeLog.push("error", `K线推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅K线失败: ${String(err)}`);
    }
  }

  private syncLocksWithOrders(orders: AsterOrder[] | null | undefined): void {
    const list = Array.isArray(orders) ? orders : [];
    Object.keys(this.pending).forEach((type) => {
      const pendingId = this.pending[type];
      if (!pendingId) return;
      const match = list.find((order) => String(order.orderId) === pendingId);
      if (
        !match ||
        (match.status &&
          match.status !== "NEW" &&
          match.status !== "PARTIALLY_FILLED")
      ) {
        unlockOperating(this.locks, this.timers, this.pending, type);
      }
    });
  }

  private isReady(): boolean {
    return Boolean(this.accountSnapshot && this.depthSnapshot);
  }

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    let hadRateLimit = false;
    try {
      const decision = this.rateLimit.beforeCycle();
      if (decision === "paused") {
        this.emitUpdate();
        return;
      }
      if (decision === "skip") {
        return;
      }
      if (!this.isReady()) {
        this.emitUpdate();
        return;
      }
      if (!(await this.ensureStartupOrderReset())) {
        this.emitUpdate();
        return;
      }

      const depth = this.depthSnapshot!;
      const { topBid, topAsk } = getTopPrices(depth);
      if (topBid == null || topAsk == null) {
        this.emitUpdate();
        return;
      }

      const bidPrice = roundDownToTick(
        topBid - this.config.bidOffset,
        this.config.priceTick
      );
      const askPrice = roundDownToTick(
        topAsk + this.config.askOffset,
        this.config.priceTick
      );
      const position = getPosition(this.accountSnapshot, this.config.symbol);
      const absPosition = Math.abs(position.positionAmt);
      const desired: DesiredOrder[] = [];
      const canEnter = !this.rateLimit.shouldBlockEntries();

      if (absPosition < EPS) {
        this.entryPricePendingLogged = false;
        if (canEnter) {
          desired.push({
            side: "BUY",
            price: bidPrice,
            amount: this.config.tradeAmount,
            reduceOnly: false,
          });
          desired.push({
            side: "SELL",
            price: askPrice,
            amount: this.config.tradeAmount,
            reduceOnly: false,
          });
        }
      } else {
        const closeSide: "BUY" | "SELL" =
          position.positionAmt > 0 ? "SELL" : "BUY";
        const closePrice = closeSide === "SELL" ? askPrice : bidPrice;
        desired.push({
          side: closeSide,
          price: closePrice,
          amount: absPosition,
          reduceOnly: true,
        });
      }

      this.desiredOrders = desired;
      this.updateSessionVolume(position);
      await this.syncOrders(desired);
      await this.checkRisk(position, bidPrice, askPrice);
      this.emitUpdate();
    } catch (error) {
      if (isRateLimitError(error)) {
        hadRateLimit = true;
        this.rateLimit.registerRateLimit("maker");
        await this.enforceRateLimitStop();
        this.tradeLog.push("warn", `MakerEngine 429: ${String(error)}`);
        // 发送 429 错误通知
        this.sendErrorNotification(error, true).catch((err) =>
          console.error("发送429错误通知失败:", err)
        );
      } else {
        this.tradeLog.push("error", `做市循环异常: ${String(error)}`);
        // 发送普通错误通知
        this.sendErrorNotification(error, false).catch((err) =>
          console.error("发送错误通知失败:", err)
        );
      }
      this.emitUpdate();
    } finally {
      this.rateLimit.onCycleComplete(hadRateLimit);
      this.processing = false;
    }
  }

  private async enforceRateLimitStop(): Promise<void> {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    if (Math.abs(position.positionAmt) < EPS) return;
    const { topBid, topAsk } = getTopPrices(this.depthSnapshot);
    if (topBid == null || topAsk == null) return;
    const bidPrice = roundDownToTick(
      topBid - this.config.bidOffset,
      this.config.priceTick
    );
    const askPrice = roundDownToTick(
      topAsk + this.config.askOffset,
      this.config.priceTick
    );
    await this.checkRisk(position, bidPrice, askPrice);
    await this.flushOrders();
  }

  private async ensureStartupOrderReset(): Promise<boolean> {
    if (this.initialOrderResetDone) return true;
    if (!this.initialOrderSnapshotReady) return false;
    if (!this.openOrders.length) {
      this.initialOrderResetDone = true;
      return true;
    }
    try {
      await this.exchange.cancelAllOrders({ symbol: this.config.symbol });
      this.pendingCancelOrders.clear();
      unlockOperating(this.locks, this.timers, this.pending, "LIMIT");
      this.openOrders = [];
      this.emitUpdate();
      this.tradeLog.push("order", "启动时清理历史挂单");
      this.initialOrderResetDone = true;
      return true;
    } catch (error) {
      if (isUnknownOrderError(error)) {
        this.tradeLog.push("order", "历史挂单已消失，跳过启动清理");
        this.initialOrderResetDone = true;
        this.openOrders = [];
        this.emitUpdate();
        return true;
      }
      this.tradeLog.push("error", `启动撤单失败: ${String(error)}`);
      return false;
    }
  }

  private async syncOrders(targets: DesiredOrder[]): Promise<void> {
    const tolerance = this.config.priceChaseThreshold;
    const availableOrders = this.openOrders.filter(
      (o) => !this.pendingCancelOrders.has(o.orderId)
    );
    const { toCancel, toPlace } = makeOrderPlan(
      availableOrders,
      targets,
      tolerance
    );

    for (const order of toCancel) {
      if (this.pendingCancelOrders.has(order.orderId)) continue;
      this.pendingCancelOrders.add(order.orderId);
      await safeCancelOrder(
        this.exchange,
        this.config.symbol,
        order,
        () => {
          this.tradeLog.push(
            "order",
            `撤销不匹配订单 ${order.side} @ ${order.price} reduceOnly=${order.reduceOnly}`
          );
        },
        () => {
          this.tradeLog.push("order", "撤销时发现订单已被成交/取消，忽略");
          this.pendingCancelOrders.delete(order.orderId);
          this.openOrders = this.openOrders.filter(
            (existing) => existing.orderId !== order.orderId
          );
        },
        (error) => {
          this.tradeLog.push("error", `撤销订单失败: ${String(error)}`);
          this.pendingCancelOrders.delete(order.orderId);
          this.openOrders = this.openOrders.filter(
            (existing) => existing.orderId !== order.orderId
          );
        }
      );
    }

    for (const target of toPlace) {
      if (!target) continue;
      if (target.amount < EPS) continue;
      try {
        await placeOrder(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pending,
          target.side,
          target.price,
          target.amount,
          (type, detail) => this.tradeLog.push(type, detail),
          target.reduceOnly,
          {
            markPrice: getPosition(this.accountSnapshot, this.config.symbol)
              .markPrice,
            maxPct: this.config.maxCloseSlippagePct,
          }
        );
      } catch (error) {
        this.tradeLog.push(
          "error",
          `挂单失败(${target.side} ${target.price}): ${String(error)}`
        );
      }
    }
  }

  private async checkRisk(
    position: PositionSnapshot,
    bidPrice: number,
    askPrice: number
  ): Promise<void> {
    const absPosition = Math.abs(position.positionAmt);
    if (absPosition < EPS) return;

    const hasEntryPrice =
      Number.isFinite(position.entryPrice) &&
      Math.abs(position.entryPrice) > 1e-8;
    if (!hasEntryPrice) {
      if (!this.entryPricePendingLogged) {
        this.tradeLog.push(
          "info",
          "做市持仓均价未同步，等待账户快照刷新后再执行止损判断"
        );
        this.entryPricePendingLogged = true;
      }
      return;
    }
    this.entryPricePendingLogged = false;

    const pnl = computePositionPnl(position, bidPrice, askPrice);
    const triggerStop = shouldStopLoss(
      position,
      bidPrice,
      askPrice,
      this.config.lossLimit
    );

    if (triggerStop) {
      // 价格操纵保护：只有平仓方向价格与标记价格在阈值内才允许市价平仓
      const closeSideIsSell = position.positionAmt > 0;
      const closeSidePrice = closeSideIsSell ? bidPrice : askPrice;
      this.tradeLog.push(
        "stop",
        `触发止损，方向=${
          position.positionAmt > 0 ? "多" : "空"
        } 当前亏损=${pnl.toFixed(4)} USDT`
      );
      try {
        await this.flushOrders();
        await marketClose(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pending,
          position.positionAmt > 0 ? "SELL" : "BUY",
          absPosition,
          (type, detail) => this.tradeLog.push(type, detail),
          {
            markPrice: position.markPrice,
            expectedPrice: Number(closeSidePrice) || null,
            maxPct: this.config.maxCloseSlippagePct,
          }
        );
      } catch (error) {
        if (isUnknownOrderError(error)) {
          this.tradeLog.push("order", "止损平仓时订单已不存在");
        } else {
          this.tradeLog.push("error", `止损平仓失败: ${String(error)}`);
        }
      }
    }
  }

  private async flushOrders(): Promise<void> {
    if (!this.openOrders.length) return;
    for (const order of this.openOrders) {
      if (this.pendingCancelOrders.has(order.orderId)) continue;
      this.pendingCancelOrders.add(order.orderId);
      await safeCancelOrder(
        this.exchange,
        this.config.symbol,
        order,
        () => {
          // 成功撤销不记录日志，保持现有行为
        },
        () => {
          this.tradeLog.push("order", "订单已不存在，撤销跳过");
          this.pendingCancelOrders.delete(order.orderId);
          this.openOrders = this.openOrders.filter(
            (existing) => existing.orderId !== order.orderId
          );
        },
        (error) => {
          this.tradeLog.push("error", `撤销订单失败: ${String(error)}`);
          this.pendingCancelOrders.delete(order.orderId);
          this.openOrders = this.openOrders.filter(
            (existing) => existing.orderId !== order.orderId
          );
        }
      );
    }
  }

  private emitUpdate(): void {
    try {
      const snapshot = this.buildSnapshot();
      const handlers = this.listeners.get("update");
      if (handlers) {
        handlers.forEach((handler) => {
          try {
            handler(snapshot);
          } catch (err) {
            this.tradeLog.push("error", `更新回调处理异常: ${String(err)}`);
          }
        });
      }
    } catch (err) {
      this.tradeLog.push("error", `快照或更新分发异常: ${String(err)}`);
    }
  }

  private buildSnapshot(): MakerEngineSnapshot {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    const { topBid, topAsk } = getTopPrices(this.depthSnapshot);
    const spread = topBid != null && topAsk != null ? topAsk - topBid : null;
    const pnl = computePositionPnl(position, topBid, topAsk);

    // 检查是否需要重置小时统计
    if (shouldResetHourlyStats(this.tradingStats.hourly)) {
      resetHourlyStats(
        this.tradingStats.hourly,
        this.tradingStats.total,
        this.config.symbol
      );
    }

    return {
      ready: this.isReady(),
      symbol: this.config.symbol,
      topBid: topBid,
      topAsk: topAsk,
      spread,
      position,
      pnl,
      accountUnrealized: this.accountUnrealized,
      sessionVolume: this.sessionQuoteVolume,
      openOrders: this.openOrders,
      desiredOrders: this.desiredOrders,
      tradeLog: this.tradeLog.all(),
      lastUpdated: Date.now(),
      tradingStats: {
        total: { ...this.tradingStats.total },
        hourly: { ...this.tradingStats.hourly },
      },
    };
  }

  private updateSessionVolume(position: PositionSnapshot): void {
    const price = this.getReferencePrice();
    if (!this.initializedPosition) {
      this.prevPositionAmt = position.positionAmt;
      this.initializedPosition = true;
      return;
    }
    if (price == null) {
      this.prevPositionAmt = position.positionAmt;
      return;
    }
    const delta = Math.abs(position.positionAmt - this.prevPositionAmt);
    if (delta > 0) {
      const tradeVolume = delta * price;
      this.sessionQuoteVolume += tradeVolume;
      // 注：交易统计现在通过真实交易数据更新，无需在此估算
    }
    this.prevPositionAmt = position.positionAmt;
  }

  private handleRealTrade(tradeData: TradeExecutionData): void {
    // 转换为 TradeData 格式
    const trade: TradeData = {
      isMaker: tradeData.isMaker,
      commission: Math.abs(tradeData.commission), // 手续费通常为负值，取绝对值
      realizedPnl: tradeData.realizedPnl,
      volume: tradeData.quoteQty, // 成交金额 (USDT)
      price: tradeData.price,
      qty: tradeData.qty,
      tradeId: tradeData.tradeId,
      timestamp: tradeData.timestamp,
    };

    // 更新总统计
    updateStatsWithRealTrade(this.tradingStats.total, trade);

    // 更新小时统计
    updateStatsWithRealTrade(this.tradingStats.hourly, trade);

    // 记录交易日志
    this.tradeLog.push(
      "trade",
      `真实交易: ${
        tradeData.isMaker ? "Maker" : "Taker"
      } | 价格=${trade.price.toFixed(4)} | 数量=${trade.qty.toFixed(
        4
      )} | 成交额=${trade.volume.toFixed(
        2
      )} USDT | 手续费=${trade.commission.toFixed(
        4
      )} USDT | 盈亏=${trade.realizedPnl.toFixed(4)} USDT`
    );

    // 发出更新
    this.emitUpdate();
  }

  private getReferencePrice(): number | null {
    return getMidOrLast(this.depthSnapshot, this.tickerSnapshot);
  }

  private async sendStartNotification(): Promise<void> {
    try {
      const { getTelegramNotifier } = await import(
        "../utils/telegram-notifier"
      );
      const notifier = getTelegramNotifier();
      if (notifier) {
        await notifier.sendStartNotification(this.config.symbol, "Maker策略");
      }
    } catch (error) {
      console.error("发送启动通知失败:", error);
    }
  }

  private async sendErrorNotification(
    error: unknown,
    isRateLimitError: boolean
  ): Promise<void> {
    try {
      const { getTelegramNotifier } = await import(
        "../utils/telegram-notifier"
      );
      const notifier = getTelegramNotifier();
      if (notifier) {
        await notifier.sendErrorNotification(
          error,
          "Maker策略",
          this.config.symbol,
          isRateLimitError
        );
      }
    } catch (err) {
      console.error("发送错误通知失败:", err);
    }
  }

  private async sendStopNotification(): Promise<void> {
    try {
      const { getTelegramNotifier } = await import(
        "../utils/telegram-notifier"
      );
      const notifier = getTelegramNotifier();
      if (notifier && this.startTime > 0) {
        const runtime = Date.now() - this.startTime;
        const totalTrades =
          this.tradingStats.total.makerOrderCount +
          this.tradingStats.total.takerOrderCount;

        await notifier.sendStopNotification(this.config.symbol, "Maker策略", {
          runtime,
          totalTrades,
          totalFees: this.tradingStats.total.totalFees,
          totalPnl: this.tradingStats.total.totalPnl,
          totalVolume: this.tradingStats.total.totalVolume,
        });
      }
    } catch (error) {
      console.error("发送停止通知失败:", error);
    }
  }
}
