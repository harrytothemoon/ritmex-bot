#!/usr/bin/env bun

import React, { useEffect, useState } from "react";
import { render } from "ink";
import { depthImbalanceConfig } from "./src/config";
import { DepthImbalanceEngine } from "./src/core/depth-imbalance-engine";
import type { DepthImbalanceSnapshot } from "./src/core/depth-imbalance-engine";
import { AsterExchangeAdapter } from "./src/exchanges/aster-adapter";
import { DepthImbalanceApp } from "./src/ui/DepthImbalanceApp";

console.log("\n🚀 正在启动深度不平衡策略...\n");
console.log("策略配置:");
console.log(`  交易对: ${depthImbalanceConfig.symbol}`);
console.log(`  交易数量: ${depthImbalanceConfig.tradeAmount}`);
console.log(`  最小深度: ${depthImbalanceConfig.minDepthQty}`);
console.log(`  不平衡倍数: ${depthImbalanceConfig.imbalanceRatio}x`);
console.log(
  `  平仓阈值: ${(depthImbalanceConfig.closeBalanceRatio * 100).toFixed(0)}%`
);
console.log(`  止损限制: ${depthImbalanceConfig.lossLimit} USDT`);
console.log(`  刷新间隔: ${depthImbalanceConfig.refreshIntervalMs}ms\n`);

const asterAdapter = new AsterExchangeAdapter({
  apiKey: process.env.ASTER_API_KEY ?? "",
  apiSecret: process.env.ASTER_API_SECRET ?? "",
});

const engine = new DepthImbalanceEngine(depthImbalanceConfig, asterAdapter);

function App() {
  const [snapshot, setSnapshot] = useState<DepthImbalanceSnapshot>(
    engine.getSnapshot()
  );

  useEffect(() => {
    const handler = (snap: DepthImbalanceSnapshot) => {
      setSnapshot(snap);
    };
    engine.on("update", handler);
    engine.start();

    return () => {
      engine.off("update", handler);
      engine.stop();
    };
  }, []);

  return <DepthImbalanceApp snapshot={snapshot} />;
}

render(<App />);
