import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { makerConfig } from "../config";
import { AsterExchangeAdapter } from "../exchanges/aster-adapter";
import { OffsetMakerEngine, type OffsetMakerEngineSnapshot } from "../core/offset-maker-engine";
import { DataTable, type TableColumn } from "./components/DataTable";
import { formatNumber } from "../utils/format";
import { formatStatsForDisplay } from "../core/trading-stats";

interface OffsetMakerAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function OffsetMakerApp({ onExit }: OffsetMakerAppProps) {
  const [snapshot, setSnapshot] = useState<OffsetMakerEngineSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<OffsetMakerEngine | null>(null);

  useInput(
    (input, key) => {
      if (key.escape) {
        engineRef.current?.stop();
        onExit();
      }
    },
    { isActive: inputSupported }
  );

  useEffect(() => {
    const apiKey = process.env.ASTER_API_KEY;
    const apiSecret = process.env.ASTER_API_SECRET;
    if (!apiKey || !apiSecret) {
      setError(new Error("缺少 ASTER_API_KEY 或 ASTER_API_SECRET 环境变量"));
      return;
    }
    try {
      const adapter = new AsterExchangeAdapter({
        apiKey,
        apiSecret,
        symbol: makerConfig.symbol,
      });
      const engine = new OffsetMakerEngine(makerConfig, adapter);
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: OffsetMakerEngineSnapshot) => {
        setSnapshot({ ...next, tradeLog: [...next.tradeLog] });
      };
      engine.on("update", handler);
      engine.start();
      return () => {
        engine.off("update", handler);
        engine.stop();
      };
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">启动失败: {error.message}</Text>
        <Text color="gray">请检查环境变量和网络连通性。</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>正在初始化偏移做市策略…</Text>
      </Box>
    );
  }

  const topBid = snapshot.topBid;
  const topAsk = snapshot.topAsk;
  const spreadDisplay = snapshot.spread != null ? `${snapshot.spread.toFixed(4)} USDT` : "-";
  const hasPosition = Math.abs(snapshot.position.positionAmt) > 1e-5;
  const sortedOrders = [...snapshot.openOrders].sort((a, b) =>
    (Number(b.updateTime ?? 0) - Number(a.updateTime ?? 0)) || Number(b.orderId) - Number(a.orderId)
  );
  const openOrderRows = sortedOrders.slice(0, 8).map((order) => ({
    id: order.orderId,
    side: order.side,
    price: order.price,
    qty: order.origQty,
    filled: order.executedQty,
    reduceOnly: order.reduceOnly ? "yes" : "no",
    status: order.status,
  }));
  const openOrderColumns: TableColumn[] = [
    { key: "id", header: "ID", align: "right", minWidth: 6 },
    { key: "side", header: "Side", minWidth: 4 },
    { key: "price", header: "Price", align: "right", minWidth: 10 },
    { key: "qty", header: "Qty", align: "right", minWidth: 8 },
    { key: "filled", header: "Filled", align: "right", minWidth: 8 },
    { key: "reduceOnly", header: "RO", minWidth: 4 },
    { key: "status", header: "Status", minWidth: 10 },
  ];

  const desiredRows = snapshot.desiredOrders.map((order, index) => ({
    index: index + 1,
    side: order.side,
    price: order.price,
    amount: order.amount,
    reduceOnly: order.reduceOnly ? "yes" : "no",
  }));
  const desiredColumns: TableColumn[] = [
    { key: "index", header: "#", align: "right", minWidth: 2 },
    { key: "side", header: "Side", minWidth: 4 },
    { key: "price", header: "Price", align: "right", minWidth: 10 },
    { key: "amount", header: "Qty", align: "right", minWidth: 8 },
    { key: "reduceOnly", header: "RO", minWidth: 4 },
  ];

  const lastLogs = snapshot.tradeLog.slice(-5);
  const imbalanceLabel = snapshot.depthImbalance === "balanced"
    ? "均衡"
    : snapshot.depthImbalance === "buy_dominant"
    ? "买盘占优"
    : "卖盘占优";

  // 格式化统计数据
  const totalStats = formatStatsForDisplay(snapshot.tradingStats.total);
  const hourlyStats = formatStatsForDisplay(snapshot.tradingStats.hourly);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">Offset Maker Strategy Dashboard</Text>
        <Text>
          交易对: {snapshot.symbol} ｜ 买一价: {formatNumber(topBid, 2)} ｜ 卖一价: {formatNumber(topAsk, 2)} ｜ 点差: {spreadDisplay}
        </Text>
        <Text>
          买10档累计: {formatNumber(snapshot.buyDepthSum10, 4)} ｜ 卖10档累计: {formatNumber(snapshot.sellDepthSum10, 4)} ｜ 状态: {imbalanceLabel}
        </Text>
        <Text color="gray">
          当前挂单策略: BUY {snapshot.skipBuySide ? "暂停" : "启用"} ｜ SELL {snapshot.skipSellSide ? "暂停" : "启用"} ｜ 按 Esc 返回策略选择
        </Text>
        <Text color="gray">状态: {snapshot.ready ? "实时运行" : "等待市场数据"}</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">持仓</Text>
          {hasPosition ? (
            <>
              <Text>
                方向: {snapshot.position.positionAmt > 0 ? "多" : "空"} ｜ 数量: {formatNumber(Math.abs(snapshot.position.positionAmt), 4)} ｜ 开仓价: {formatNumber(snapshot.position.entryPrice, 2)}
              </Text>
              <Text>
                浮动盈亏: {formatNumber(snapshot.pnl, 4)} USDT ｜ 账户未实现盈亏: {formatNumber(snapshot.accountUnrealized, 4)} USDT
              </Text>
            </>
          ) : (
            <Text color="gray">当前无持仓</Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">目标挂单</Text>
          {desiredRows.length > 0 ? (
            <DataTable columns={desiredColumns} rows={desiredRows} />
          ) : (
            <Text color="gray">暂无目标挂单</Text>
          )}
          <Text>
            累计成交量: {formatNumber(snapshot.sessionVolume, 2)} USDT
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="magentaBright">交易统计</Text>
        <Text>
          【近{process.env.REPORT_INTERVAL_MIN}分钟】Maker: {hourlyStats.makerCount}单 ｜ Taker: {hourlyStats.takerCount}单 ｜ 手续费: {hourlyStats.fees} USDT ｜ 盈亏: {hourlyStats.pnl} USDT ｜ 积分: {hourlyStats.volume} ｜ 积分率: {hourlyStats.pointsRate}
        </Text>
        <Text>
          【总累计】Maker: {totalStats.makerCount}单 ｜ Taker: {totalStats.takerCount}单 ｜ 手续费: {totalStats.fees} USDT ｜ 盈亏: {totalStats.pnl} USDT ｜ 积分: {totalStats.volume} ｜ 积分率: {totalStats.pointsRate}
        </Text>
        <Text color="magentaBright">團隊加成：{process.env.TEAM_BONUS_RATE}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">当前挂单</Text>
        {openOrderRows.length > 0 ? (
          <DataTable columns={openOrderColumns} rows={openOrderRows} />
        ) : (
          <Text color="gray">暂无挂单</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">最近事件</Text>
        {lastLogs.length > 0 ? (
          lastLogs.map((item, index) => (
            <Text key={`${item.time}-${index}`}>
              [{item.time}] [{item.type}] {item.detail}
            </Text>
          ))
        ) : (
          <Text color="gray">暂无日志</Text>
        )}
      </Box>
    </Box>
  );
}

