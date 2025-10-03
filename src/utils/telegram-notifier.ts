import type { HourlyStats, TradingStats } from "../core/trading-stats";
import { formatStatsForDisplay } from "../core/trading-stats";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled?: boolean;
}

export class TelegramNotifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly enabled: boolean;

  constructor(config: TelegramConfig) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.enabled = config.enabled ?? true;
  }

  /**
   * 发送交易统计消息到Telegram
   */
  async sendTradingStats(
    hourlyStats: HourlyStats,
    totalStats: TradingStats,
    symbol: string = "BTCUSDT"
  ): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    try {
      const hourlyFormatted = formatStatsForDisplay(hourlyStats);
      const totalFormatted = formatStatsForDisplay(totalStats);

      const now = new Date();
      const hourStart = new Date(hourlyStats.hourStartTime);

      const message = `🤖 *交易统计报告* - ${symbol}
      
📅 *时间*: ${now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
⏰ *统计周期*: ${hourStart.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      })} - ${now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}

📊 *近一小时统计*
• Maker订单: ${hourlyFormatted.makerCount}单
• Taker订单: ${hourlyFormatted.takerCount}单  
• 手续费: ${hourlyFormatted.fees} USDT
• 盈亏: ${hourlyFormatted.pnl} USDT
• 成交量: ${hourlyFormatted.volume} USDT
• 积分率: ${hourlyFormatted.pointsRate}

📈 *总累计统计*
• Maker订单: ${totalFormatted.makerCount}单
• Taker订单: ${totalFormatted.takerCount}单
• 手续费: ${totalFormatted.fees} USDT  
• 盈亏: ${totalFormatted.pnl} USDT
• 成交量: ${totalFormatted.volume} USDT
• 积分率: ${totalFormatted.pointsRate}

💡 团队加成率: ${process.env.TEAM_BONUS_RATE || "N/A"}`;

      return await this.sendMessage(message);
    } catch (error) {
      console.error("发送Telegram统计消息失败:", error);
      return false;
    }
  }

  /**
   * 发送普通消息到Telegram
   */
  async sendMessage(text: string): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        console.error("Telegram API错误:", result);
        return false;
      }

      return result.ok;
    } catch (error) {
      console.error("发送Telegram消息失败:", error);
      return false;
    }
  }

  /**
   * 发送程序启动通知
   */
  async sendStartNotification(
    symbol: string,
    strategyType: string = "Maker"
  ): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    try {
      const message = `🚀 *程序启动通知*

📊 *交易策略*: ${strategyType}
💰 *交易对*: ${symbol}
🕐 *启动时间*: ${new Date().toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      })}
🔄 *状态*: 正在初始化...

💡 团队加成率: ${process.env.TEAM_BONUS_RATE || "N/A"}

✅ 程序已启动，开始执行交易策略！`;

      return await this.sendMessage(message);
    } catch (error) {
      console.error("发送程序启动通知失败:", error);
      return false;
    }
  }

  /**
   * 发送程序停止通知
   */
  async sendStopNotification(
    symbol: string,
    strategyType: string = "Maker",
    totalStats?: {
      runtime: number;
      totalTrades: number;
      totalFees: number;
      totalPnl: number;
      totalVolume: number;
    }
  ): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    try {
      const runtimeHours = totalStats
        ? (totalStats.runtime / (1000 * 60 * 60)).toFixed(1)
        : "N/A";

      let message = `🛑 *程序停止通知*

📊 *交易策略*: ${strategyType}
💰 *交易对*: ${symbol}
🕐 *停止时间*: ${new Date().toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      })}`;

      if (totalStats) {
        message += `

📈 *运行总结*:
⏱️ 运行时长: ${runtimeHours} 小时
🔄 总交易笔数: ${totalStats.totalTrades}
💸 总手续费: ${totalStats.totalFees.toFixed(4)} USDT
💰 总盈亏: ${totalStats.totalPnl.toFixed(4)} USDT
📊 总成交量: ${totalStats.totalVolume.toFixed(2)} USDT`;
      }

      message += `

⚠️ 程序已停止运行！`;

      return await this.sendMessage(message);
    } catch (error) {
      console.error("发送程序停止通知失败:", error);
      return false;
    }
  }

  /**
   * 发送交易数量调整通知
   */
  async sendTradeAmountAdjustment(
    symbol: string,
    strategyType: string,
    previousAmount: number,
    newAmount: number,
    attemptNumber: number,
    reason: string = "保证金不足",
    previousLossLimit?: number,
    newLossLimit?: number
  ): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    try {
      const reductionPercent = (
        ((previousAmount - newAmount) / previousAmount) *
        100
      ).toFixed(0);

      let message = `⚠️ *交易数量调整通知*

📊 *策略*: ${strategyType}
💰 *交易对*: ${symbol}
🕐 *时间*: ${new Date().toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      })}

📉 *调整信息*:
• 原始数量: ${previousAmount.toFixed(8)}
• 新数量: ${newAmount.toFixed(8)}
• 减少: ${reductionPercent}%
• 尝试次数: ${attemptNumber}
• 原因: ${reason}`;

      if (previousLossLimit !== undefined && newLossLimit !== undefined) {
        message += `

🛡️ *止损调整*:
• 原始止损: ${previousLossLimit.toFixed(4)} USDT
• 新止损: ${newLossLimit.toFixed(4)} USDT
• 减少: ${reductionPercent}%`;
      }

      message += `

💡 系统将使用新的交易数量和止损限制继续尝试下单`;

      return await this.sendMessage(message);
    } catch (error) {
      console.error("发送交易数量调整通知失败:", error);
      return false;
    }
  }

  /**
   * 发送错误通知
   */
  async sendErrorNotification(
    error: unknown,
    strategyType: string,
    symbol: string,
    isRateLimitError: boolean = false
  ): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    try {
      const errorMessage = this.extractErrorMessage(error);
      const errorIcon = isRateLimitError ? "⚠️" : "🚨";
      const errorType = isRateLimitError ? "限频错误 (429)" : "运行错误";

      const message = `${errorIcon} *${errorType}警报*

📊 *策略*: ${strategyType}
💰 *交易对*: ${symbol}
🕐 *时间*: ${new Date().toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      })}

❌ *错误信息*:
\`\`\`
${errorMessage}
\`\`\`

${isRateLimitError ? "⏸️ 已自动触发降频/暂停机制" : "⚠️ 请检查策略运行状态"}`;

      return await this.sendMessage(message);
    } catch (err) {
      console.error("发送错误通知失败:", err);
      return false;
    }
  }

  /**
   * 提取错误信息
   */
  private extractErrorMessage(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  /**
   * 测试Telegram连接
   */
  async testConnection(): Promise<boolean> {
    if (!this.enabled) {
      console.log("Telegram通知已禁用");
      return true;
    }

    try {
      const testMessage = `🧪 *测试消息*

Ritmex Bot Telegram集成测试成功！

时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`;

      const success = await this.sendMessage(testMessage);
      if (success) {
        console.log("✅ Telegram连接测试成功");
      } else {
        console.error("❌ Telegram连接测试失败");
      }
      return success;
    } catch (error) {
      console.error("❌ Telegram连接测试异常:", error);
      return false;
    }
  }
}

// 创建全局单例
let telegramNotifier: TelegramNotifier | null = null;

export function getTelegramNotifier(): TelegramNotifier | null {
  if (telegramNotifier) {
    return telegramNotifier;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const enabled = process.env.TELEGRAM_ENABLED !== "false"; // 默认启用

  if (!botToken || !chatId) {
    console.warn(
      "⚠️  缺少TELEGRAM_BOT_TOKEN或TELEGRAM_CHAT_ID环境变量，Telegram通知将被禁用"
    );
    return null;
  }

  try {
    telegramNotifier = new TelegramNotifier({
      botToken,
      chatId,
      enabled,
    });

    console.log("📱 Telegram通知器初始化成功");
    return telegramNotifier;
  } catch (error) {
    console.error("❌ Telegram通知器初始化失败:", error);
    return null;
  }
}
