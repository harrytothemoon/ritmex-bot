import React from "react";
import { render } from "ink";
import { App } from "./ui/App";
import { setupGlobalErrorHandlers } from "./runtime-errors";

setupGlobalErrorHandlers();

// 设置程序退出时的Telegram通知
let appStartTime = Date.now();

async function sendAppExitNotification() {
  try {
    const { getTelegramNotifier } = await import("./utils/telegram-notifier");
    const notifier = getTelegramNotifier();
    if (notifier) {
      const runtime = Date.now() - appStartTime;
      const runtimeHours = (runtime / (1000 * 60 * 60)).toFixed(1);

      await notifier.sendMessage(`🔄 *应用程序退出*

⏱️ 运行时长: ${runtimeHours} 小时
🕐 退出时间: ${new Date().toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      })}

👋 Ritmex Bot 已退出，感谢使用！`);
    }
  } catch (error) {
    console.error("发送程序退出通知失败:", error);
  }
}

// 监听程序退出事件
process.on("SIGINT", async () => {
  console.log("\n正在退出程序...");
  await sendAppExitNotification();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n正在退出程序...");
  await sendAppExitNotification();
  process.exit(0);
});

render(<App />);
