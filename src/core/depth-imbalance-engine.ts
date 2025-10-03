import type { DepthImbalanceConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterTicker,
  AsterOrder,
} from "../exchanges/types";
import { createTradeLog, type TradeLogEntry } from "../state/trade-log";
import {
  isUnknownOrderError,
  isRateLimitError,
  isInsufficientMarginError,
} from "../utils/errors";
import { getPosition, type PositionSnapshot } from "../utils/strategy";
import { computePositionPnl } from "../utils/pnl";
import { getTopPrices, getMidOrLast } from "../utils/price";
import { marketClose } from "./order-coordinator";
import type {
  OrderLockMap,
  OrderPendingMap,
  OrderTimerMap,
} from "./order-coordinator";
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

export interface DepthImbalanceSnapshot {
  ready: boolean;
  symbol: string;
  topBid: number | null;
  topAsk: number | null;
  bidQty: number;
  askQty: number;
  imbalanceRatio: number | null; // 大的一方 / 小的一方
  position: PositionSnapshot;
  pnl: number;
  accountUnrealized: number;
  accountBalance: number; // 账户总余额
  availableBalance: number; // 可用余额
  sessionVolume: number;
  tradeLog: TradeLogEntry[];
  lastUpdated: number;
  // 策略状态
  hasPosition: boolean;
  positionSide: "LONG" | "SHORT" | null;
  entryBidQty: number;
  entryAskQty: number;
  shouldClose: boolean;
  closeReason: string | null;
  // 交易数量管理
  currentTradeAmount: number;
  initialTradeAmount: number;
  minTradeAmount: number;
  // 止损限制管理
  currentLossLimit: number;
  initialLossLimit: number;
  // 交易统计信息
  tradingStats: TradingStatsSummary;
}

type DepthImbalanceEvent = "update";
type DepthImbalanceListener = (snapshot: DepthImbalanceSnapshot) => void;

const EPS = 1e-5;

export class DepthImbalanceEngine {
  private accountSnapshot: AsterAccountSnapshot | null = null;
  private depthSnapshot: AsterDepth | null = null;
  private tickerSnapshot: AsterTicker | null = null;
  private openOrders: AsterOrder[] = [];

  private readonly locks: OrderLockMap = {};
  private readonly timers: OrderTimerMap = {};
  private readonly pending: OrderPendingMap = {};

  private readonly tradeLog: ReturnType<typeof createTradeLog>;
  private readonly listeners = new Map<
    DepthImbalanceEvent,
    Set<DepthImbalanceListener>
  >();

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private accountUnrealized = 0;
  private accountBalance = 0;
  private availableBalance = 0;
  private sessionQuoteVolume = 0;
  private prevPositionAmt = 0;
  private initializedPosition = false;
  private readonly rateLimit: RateLimitController;

  // 策略状态
  private entryBidQty = 0;
  private entryAskQty = 0;
  private positionSide: "LONG" | "SHORT" | null = null;

  // 交易统计数据
  private tradingStats: TradingStatsSummary;
  private startTime: number = 0;

  // 动态交易数量管理
  private currentTradeAmount: number;
  private readonly minTradeAmount: number;
  private readonly maxRetryAttempts: number;
  // 动态止损限制管理
  private currentLossLimit: number;

  constructor(
    private readonly config: DepthImbalanceConfig,
    private readonly exchange: ExchangeAdapter
  ) {
    // 初始化交易数量
    this.currentTradeAmount = this.config.tradeAmount;
    // 设置最小交易数量为初始值的 1/64（最多减半6次）
    // 你可以根据需要调整这个值：
    // - 1/32 = 最多减半5次（6次尝试）
    // - 1/64 = 最多减半6次（7次尝试）
    // - 1/128 = 最多减半7次（8次尝试）
    this.minTradeAmount = this.config.tradeAmount / 128;
    // 最大尝试次数：初始尝试 + 减半次数
    this.maxRetryAttempts = 10;
    // 初始化止损限制（与交易数量同步调整）
    this.currentLossLimit = this.config.lossLimit;
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

    this.tradeLog.push(
      "info",
      `深度不平衡策略启动 | 最小深度=${this.config.minDepthQty} | 不平衡倍数=${this.config.imbalanceRatio}x | 平仓阈值=${this.config.closeBalanceRatio}% | 初始交易量=${this.currentTradeAmount} | 止损限制=${this.currentLossLimit} USDT`
    );

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

  on(event: DepthImbalanceEvent, handler: DepthImbalanceListener): void {
    const handlers =
      this.listeners.get(event) ?? new Set<DepthImbalanceListener>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  off(event: DepthImbalanceEvent, handler: DepthImbalanceListener): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.listeners.delete(event);
    }
  }

  getSnapshot(): DepthImbalanceSnapshot {
    return this.buildSnapshot();
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
          // 更新账户余额
          const totalBalance = Number(snapshot.totalWalletBalance ?? "0");
          if (Number.isFinite(totalBalance)) {
            this.accountBalance = totalBalance;
          }
          const available = Number(snapshot.availableBalance ?? "0");
          if (Number.isFinite(available)) {
            this.availableBalance = available;
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
          this.openOrders = Array.isArray(orders)
            ? orders.filter(
                (order) =>
                  order.type !== "MARKET" && order.symbol === this.config.symbol
              )
            : [];
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

      const depth = this.depthSnapshot!;
      const { topBid, topAsk } = getTopPrices(depth);
      if (topBid == null || topAsk == null) {
        this.emitUpdate();
        return;
      }

      // 获取第一档买卖数量
      const bidQty = Number(depth.bids?.[0]?.[1] ?? 0);
      const askQty = Number(depth.asks?.[0]?.[1] ?? 0);

      if (bidQty <= 0 || askQty <= 0) {
        this.emitUpdate();
        return;
      }

      const position = getPosition(this.accountSnapshot, this.config.symbol);
      const absPosition = Math.abs(position.positionAmt);

      // 检查是否有持仓
      if (absPosition < EPS) {
        // 无持仓，检查是否满足建仓条件
        await this.checkEntryCondition(bidQty, askQty, topBid, topAsk);
      } else {
        // 有持仓，检查是否满足平仓条件
        await this.checkExitCondition(position, bidQty, askQty, topBid, topAsk);
      }

      await this.checkStopLoss(position, topBid, topAsk);
      this.emitUpdate();
    } catch (error) {
      if (isRateLimitError(error)) {
        hadRateLimit = true;
        this.rateLimit.registerRateLimit("depth-imbalance");
        await this.enforceRateLimitStop();
        this.tradeLog.push(
          "warn",
          `DepthImbalanceEngine 429: ${String(error)}`
        );
        this.sendErrorNotification(error, true).catch((err) =>
          console.error("发送429错误通知失败:", err)
        );
      } else {
        this.tradeLog.push("error", `深度不平衡策略异常: ${String(error)}`);
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

  private async checkEntryCondition(
    bidQty: number,
    askQty: number,
    topBid: number,
    topAsk: number
  ): Promise<void> {
    // 条件1: 至少一档数量 > 最小深度要求
    if (bidQty < this.config.minDepthQty && askQty < this.config.minDepthQty) {
      return;
    }

    // 条件2: 一档是另一档的 N 倍以上
    const ratio = Math.max(bidQty, askQty) / Math.min(bidQty, askQty);
    if (ratio < this.config.imbalanceRatio) {
      return;
    }

    // 判断方向：买单多则做多，卖单多则做空
    const side: "BUY" | "SELL" = bidQty > askQty ? "BUY" : "SELL";
    const positionSide: "LONG" | "SHORT" = side === "BUY" ? "LONG" : "SHORT";

    this.tradeLog.push(
      "signal",
      `检测到深度不平衡 | 买=${bidQty.toFixed(4)} 卖=${askQty.toFixed(
        4
      )} 比率=${ratio.toFixed(2)}x | 执行${
        positionSide === "LONG" ? "做多" : "做空"
      }`
    );

    // 记录建仓时的深度数据
    this.entryBidQty = bidQty;
    this.entryAskQty = askQty;
    this.positionSide = positionSide;

    // 市价建仓
    try {
      await this.marketEntry(side);
    } catch (error) {
      if (isUnknownOrderError(error)) {
        this.tradeLog.push("order", "建仓订单已不存在");
      } else {
        this.tradeLog.push("error", `市价建仓失败: ${String(error)}`);
      }
      // 重置状态
      this.positionSide = null;
      this.entryBidQty = 0;
      this.entryAskQty = 0;
    }
  }

  private async checkExitCondition(
    position: PositionSnapshot,
    bidQty: number,
    askQty: number,
    topBid: number,
    topAsk: number
  ): Promise<void> {
    if (!this.positionSide) {
      // 如果没有记录方向，根据持仓推断
      this.positionSide = position.positionAmt > 0 ? "LONG" : "SHORT";
    }

    // 计算当前深度平衡度
    // 如果是多头：关注卖单是否接近买单（市场趋于平衡）
    // 如果是空头：关注买单是否接近卖单
    let shouldClose = false;
    let closeReason = "";

    if (this.positionSide === "LONG") {
      // 多头：当卖单数量 >= 买单数量 * 平仓阈值时平仓
      const threshold = bidQty * this.config.closeBalanceRatio;
      if (askQty >= threshold) {
        shouldClose = true;
        closeReason = `卖单接近买单 | 买=${bidQty.toFixed(
          4
        )} 卖=${askQty.toFixed(4)} 阈值=${threshold.toFixed(4)}`;
      }
    } else if (this.positionSide === "SHORT") {
      // 空头：当买单数量 >= 卖单数量 * 平仓阈值时平仓
      const threshold = askQty * this.config.closeBalanceRatio;
      if (bidQty >= threshold) {
        shouldClose = true;
        closeReason = `买单接近卖单 | 买=${bidQty.toFixed(
          4
        )} 卖=${askQty.toFixed(4)} 阈值=${threshold.toFixed(4)}`;
      }
    }

    if (shouldClose) {
      this.tradeLog.push("signal", `触发平仓条件: ${closeReason}`);
      await this.marketExit(position, topBid, topAsk);
    }
  }

  private async checkStopLoss(
    position: PositionSnapshot,
    topBid: number | null,
    topAsk: number | null
  ): Promise<void> {
    const absPosition = Math.abs(position.positionAmt);
    if (absPosition < EPS) return;

    const pnl = computePositionPnl(position, topBid, topAsk);
    if (pnl <= -this.currentLossLimit) {
      this.tradeLog.push(
        "stop",
        `触发止损 | 当前亏损=${pnl.toFixed(4)} USDT 超过限制=${
          this.currentLossLimit
        } USDT`
      );
      await this.marketExit(position, topBid, topAsk);
    }
  }

  private async marketEntry(side: "BUY" | "SELL"): Promise<void> {
    let attemptAmount = this.currentTradeAmount;
    let attempts = 0;

    while (attempts < this.maxRetryAttempts) {
      try {
        // 检查是否已经低于最小交易数量
        if (attemptAmount < this.minTradeAmount) {
          this.tradeLog.push(
            "error",
            `交易数量 ${attemptAmount.toFixed(
              8
            )} 已低于最小限制 ${this.minTradeAmount.toFixed(8)}，无法继续建仓`
          );
          throw new Error("交易数量已降至最小限制，仍然保证金不足");
        }

        const result = await this.exchange.createOrder({
          symbol: this.config.symbol,
          side,
          type: "MARKET",
          quantity: attemptAmount,
        });

        // 成功下单，更新当前交易数量
        this.currentTradeAmount = attemptAmount;

        const adjustmentInfo =
          attemptAmount < this.config.tradeAmount
            ? ` | 已调整交易量（原始: ${this.config.tradeAmount.toFixed(
                8
              )}，当前止损: ${this.currentLossLimit.toFixed(4)} USDT）`
            : "";

        this.tradeLog.push(
          "order",
          `市价${side === "BUY" ? "买入" : "卖出"} ${attemptAmount.toFixed(
            8
          )} | 订单ID=${result.orderId}${adjustmentInfo}`
        );

        return; // 成功，退出
      } catch (error) {
        attempts++;

        if (isInsufficientMarginError(error)) {
          // 保证金不足，减半交易数量和止损限制
          const previousAmount = attemptAmount;
          const previousLossLimit = this.currentLossLimit;
          attemptAmount = attemptAmount / 2;
          this.currentLossLimit = this.currentLossLimit / 2;

          this.tradeLog.push(
            "warn",
            `保证金不足（尝试 ${attempts}/${
              this.maxRetryAttempts
            }）| 将交易量从 ${previousAmount.toFixed(
              8
            )} 减半至 ${attemptAmount.toFixed(
              8
            )} | 止损限制从 ${previousLossLimit.toFixed(
              4
            )} 减半至 ${this.currentLossLimit.toFixed(4)} USDT`
          );

          // 发送Telegram通知
          this.sendTradeAmountAdjustmentNotification(
            previousAmount,
            attemptAmount,
            attempts,
            previousLossLimit,
            this.currentLossLimit
          ).catch((err) => console.error("发送交易数量调整通知失败:", err));

          // 如果还有重试机会，继续循环
          if (
            attempts < this.maxRetryAttempts &&
            attemptAmount >= this.minTradeAmount
          ) {
            continue;
          }
        }

        // 其他错误或已达到最大尝试次数，抛出错误
        throw error;
      }
    }

    // 如果执行到这里，说明所有尝试都失败了
    throw new Error(`经过 ${this.maxRetryAttempts} 次尝试仍无法下单`);
  }

  private async marketExit(
    position: PositionSnapshot,
    topBid: number | null,
    topAsk: number | null
  ): Promise<void> {
    const absPosition = Math.abs(position.positionAmt);
    if (absPosition < EPS) return;

    const side: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";

    try {
      await marketClose(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        absPosition,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: position.markPrice,
          expectedPrice: Number(side === "SELL" ? topBid : topAsk) || null,
          maxPct: this.config.maxCloseSlippagePct,
        }
      );

      // 重置状态
      this.positionSide = null;
      this.entryBidQty = 0;
      this.entryAskQty = 0;
    } catch (error) {
      if (isUnknownOrderError(error)) {
        this.tradeLog.push("order", "平仓订单已不存在");
      } else {
        this.tradeLog.push("error", `市价平仓失败: ${String(error)}`);
      }
    }
  }

  private async enforceRateLimitStop(): Promise<void> {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    if (Math.abs(position.positionAmt) < EPS) return;

    const absPosition = Math.abs(position.positionAmt);
    const side: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
    const { topBid, topAsk } = getTopPrices(this.depthSnapshot);

    try {
      await marketClose(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        absPosition,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: position.markPrice,
          expectedPrice: Number(side === "SELL" ? topBid : topAsk) || null,
          maxPct: this.config.maxCloseSlippagePct,
        }
      );
    } catch (error) {
      if (isUnknownOrderError(error)) {
        this.tradeLog.push("order", "限频强制平仓时订单已不存在");
      } else {
        this.tradeLog.push("error", `限频强制平仓失败: ${String(error)}`);
      }
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

  private buildSnapshot(): DepthImbalanceSnapshot {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    const { topBid, topAsk } = getTopPrices(this.depthSnapshot);
    const pnl = computePositionPnl(position, topBid, topAsk);

    const bidQty = Number(this.depthSnapshot?.bids?.[0]?.[1] ?? 0);
    const askQty = Number(this.depthSnapshot?.asks?.[0]?.[1] ?? 0);
    const imbalanceRatio =
      bidQty > 0 && askQty > 0
        ? Math.max(bidQty, askQty) / Math.min(bidQty, askQty)
        : null;

    const absPosition = Math.abs(position.positionAmt);
    const hasPosition = absPosition >= EPS;

    // 计算是否应该平仓
    let shouldClose = false;
    let closeReason: string | null = null;

    if (hasPosition && this.positionSide) {
      if (this.positionSide === "LONG") {
        const threshold = bidQty * this.config.closeBalanceRatio;
        if (askQty >= threshold) {
          shouldClose = true;
          closeReason = `卖单达到买单的${(
            this.config.closeBalanceRatio * 100
          ).toFixed(0)}%`;
        }
      } else if (this.positionSide === "SHORT") {
        const threshold = askQty * this.config.closeBalanceRatio;
        if (bidQty >= threshold) {
          shouldClose = true;
          closeReason = `买单达到卖单的${(
            this.config.closeBalanceRatio * 100
          ).toFixed(0)}%`;
        }
      }
    }

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
      topBid,
      topAsk,
      bidQty,
      askQty,
      imbalanceRatio,
      position,
      pnl,
      accountUnrealized: this.accountUnrealized,
      accountBalance: this.accountBalance,
      availableBalance: this.availableBalance,
      sessionVolume: this.sessionQuoteVolume,
      tradeLog: this.tradeLog.all(),
      lastUpdated: Date.now(),
      hasPosition,
      positionSide: this.positionSide,
      entryBidQty: this.entryBidQty,
      entryAskQty: this.entryAskQty,
      shouldClose,
      closeReason,
      currentTradeAmount: this.currentTradeAmount,
      initialTradeAmount: this.config.tradeAmount,
      minTradeAmount: this.minTradeAmount,
      currentLossLimit: this.currentLossLimit,
      initialLossLimit: this.config.lossLimit,
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
    }
    this.prevPositionAmt = position.positionAmt;
  }

  private handleRealTrade(tradeData: TradeExecutionData): void {
    const trade: TradeData = {
      isMaker: tradeData.isMaker,
      commission: Math.abs(tradeData.commission),
      realizedPnl: tradeData.realizedPnl,
      volume: tradeData.quoteQty,
      price: tradeData.price,
      qty: tradeData.qty,
      tradeId: tradeData.tradeId,
      timestamp: tradeData.timestamp,
    };

    updateStatsWithRealTrade(this.tradingStats.total, trade);
    updateStatsWithRealTrade(this.tradingStats.hourly, trade);

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
        await notifier.sendStartNotification(
          this.config.symbol,
          "深度不平衡策略"
        );
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
          "深度不平衡策略",
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

        await notifier.sendStopNotification(
          this.config.symbol,
          "深度不平衡策略",
          {
            runtime,
            totalTrades,
            totalFees: this.tradingStats.total.totalFees,
            totalPnl: this.tradingStats.total.totalPnl,
            totalVolume: this.tradingStats.total.totalVolume,
          }
        );
      }
    } catch (error) {
      console.error("发送停止通知失败:", error);
    }
  }

  private async sendTradeAmountAdjustmentNotification(
    previousAmount: number,
    newAmount: number,
    attemptNumber: number,
    previousLossLimit?: number,
    newLossLimit?: number
  ): Promise<void> {
    try {
      const { getTelegramNotifier } = await import(
        "../utils/telegram-notifier"
      );
      const notifier = getTelegramNotifier();
      if (notifier) {
        await notifier.sendTradeAmountAdjustment(
          this.config.symbol,
          "深度不平衡策略",
          previousAmount,
          newAmount,
          attemptNumber,
          "保证金不足",
          previousLossLimit,
          newLossLimit
        );
      }
    } catch (error) {
      console.error("发送交易数量调整通知失败:", error);
    }
  }
}
