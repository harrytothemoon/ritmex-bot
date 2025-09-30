import React from "react";
import { Box, Text } from "ink";
import type { DepthImbalanceSnapshot } from "../core/depth-imbalance-engine";
import { KeyValueTable } from "./components/KeyValueTable";

interface DepthImbalanceAppProps {
  snapshot: DepthImbalanceSnapshot;
}

export function DepthImbalanceApp({ snapshot }: DepthImbalanceAppProps) {
  const {
    ready,
    symbol,
    topBid,
    topAsk,
    bidQty,
    askQty,
    imbalanceRatio,
    position,
    pnl,
    accountUnrealized,
    sessionVolume,
    tradeLog,
    hasPosition,
    positionSide,
    entryBidQty,
    entryAskQty,
    shouldClose,
    closeReason,
    tradingStats,
  } = snapshot;

  const statusColor = ready ? "green" : "yellow";
  const pnlColor = pnl >= 0 ? "green" : "red";

  // 市场深度信息
  const depthRows = [
    {
      label: "买一价",
      value: topBid != null ? topBid.toFixed(2) : "N/A",
    },
    {
      label: "买一量",
      value: bidQty.toFixed(4),
      color: bidQty > askQty ? "green" : undefined,
    },
    {
      label: "卖一价",
      value: topAsk != null ? topAsk.toFixed(2) : "N/A",
    },
    {
      label: "卖一量",
      value: askQty.toFixed(4),
      color: askQty > bidQty ? "green" : undefined,
    },
    {
      label: "不平衡比",
      value: imbalanceRatio != null ? `${imbalanceRatio.toFixed(2)}x` : "N/A",
      color:
        imbalanceRatio != null && imbalanceRatio >= 6 ? "yellow" : undefined,
    },
  ];

  // 持仓信息
  const positionRows = [
    {
      label: "持仓状态",
      value: hasPosition ? (positionSide === "LONG" ? "多头" : "空头") : "空仓",
      color: hasPosition ? "cyan" : undefined,
    },
    {
      label: "持仓数量",
      value: position.positionAmt.toFixed(4),
    },
    {
      label: "持仓盈亏",
      value: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT`,
      color: pnlColor,
    },
    {
      label: "建仓买量",
      value: hasPosition ? entryBidQty.toFixed(4) : "N/A",
    },
    {
      label: "建仓卖量",
      value: hasPosition ? entryAskQty.toFixed(4) : "N/A",
    },
  ];

  // 平仓信号
  const closeSignalRows = [
    {
      label: "平仓信号",
      value: shouldClose ? "是" : "否",
      color: shouldClose ? "red" : "green",
    },
    {
      label: "平仓原因",
      value: closeReason || "N/A",
    },
  ];

  // 交易统计（总计）
  const totalStats = tradingStats.total;
  const totalStatsRows = [
    {
      label: "总成交量",
      value: `${totalStats.totalVolume.toFixed(2)} USDT`,
    },
    {
      label: "Maker订单",
      value: `${totalStats.makerOrderCount} 单`,
    },
    {
      label: "Taker订单",
      value: `${totalStats.takerOrderCount} 单`,
    },
    {
      label: "总手续费",
      value: `${totalStats.totalFees.toFixed(4)} USDT`,
      color: "red",
    },
    {
      label: "已实现盈亏",
      value: `${
        totalStats.totalPnl >= 0 ? "+" : ""
      }${totalStats.totalPnl.toFixed(4)} USDT`,
      color: totalStats.totalPnl >= 0 ? "green" : "red",
    },
    {
      label: "净收益",
      value: `${totalStats.netPnl >= 0 ? "+" : ""}${totalStats.netPnl.toFixed(
        4
      )} USDT`,
      color: totalStats.netPnl >= 0 ? "green" : "red",
    },
  ];

  // 小时统计
  const hourlyStats = tradingStats.hourly;
  const hourStartTime = new Date(hourlyStats.hourStartTime).toLocaleTimeString(
    "zh-CN",
    { hour: "2-digit", minute: "2-digit" }
  );
  const hourlyStatsRows = [
    {
      label: "小时周期",
      value: `${hourStartTime} - 当前`,
    },
    {
      label: "小时成交",
      value: `${hourlyStats.totalVolume.toFixed(2)} USDT`,
    },
    {
      label: "小时订单",
      value: `${hourlyStats.makerOrderCount + hourlyStats.takerOrderCount} 单`,
    },
    {
      label: "小时手续费",
      value: `${hourlyStats.totalFees.toFixed(4)} USDT`,
      color: "red",
    },
    {
      label: "小时盈亏",
      value: `${
        hourlyStats.totalPnl >= 0 ? "+" : ""
      }${hourlyStats.totalPnl.toFixed(4)} USDT`,
      color: hourlyStats.totalPnl >= 0 ? "green" : "red",
    },
    {
      label: "小时净收益",
      value: `${hourlyStats.netPnl >= 0 ? "+" : ""}${hourlyStats.netPnl.toFixed(
        4
      )} USDT`,
      color: hourlyStats.netPnl >= 0 ? "green" : "red",
    },
  ];

  // 账户信息
  const accountRows = [
    {
      label: "账户浮亏",
      value: `${accountUnrealized >= 0 ? "+" : ""}${accountUnrealized.toFixed(
        4
      )} USDT`,
      color: accountUnrealized >= 0 ? "green" : "red",
    },
    {
      label: "会话交易量",
      value: `${sessionVolume.toFixed(2)} USDT`,
    },
  ];

  const recentLogs = tradeLog.slice(-8);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={statusColor}>
          ═══ 深度不平衡策略 [{symbol}] {ready ? "✓" : "⏳"} ═══
        </Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={2}>
          <Text bold underline>
            市场深度
          </Text>
          <KeyValueTable data={depthRows} />
        </Box>
        <Box flexDirection="column" marginRight={2}>
          <Text bold underline>
            持仓信息
          </Text>
          <KeyValueTable data={positionRows} />
        </Box>
        <Box flexDirection="column">
          <Text bold underline>
            平仓信号
          </Text>
          <KeyValueTable data={closeSignalRows} />
        </Box>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={2}>
          <Text bold underline>
            总计统计
          </Text>
          <KeyValueTable data={totalStatsRows} />
        </Box>
        <Box flexDirection="column" marginRight={2}>
          <Text bold underline>
            小时统计
          </Text>
          <KeyValueTable data={hourlyStatsRows} />
        </Box>
        <Box flexDirection="column">
          <Text bold underline>
            账户信息
          </Text>
          <KeyValueTable data={accountRows} />
        </Box>
      </Box>

      <Box flexDirection="column">
        <Text bold underline>
          交易日志
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {recentLogs.map((log, idx) => {
            const time = new Date(log.time).toLocaleTimeString("zh-CN");
            const typeColors: Record<string, string> = {
              signal: "cyan",
              order: "blue",
              stop: "red",
              warn: "yellow",
              error: "red",
              trade: "green",
            };
            const color = typeColors[log.type] || "white";
            return (
              <Text key={idx} color={color}>
                [{time}] {log.type.toUpperCase()}: {log.detail}
              </Text>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
