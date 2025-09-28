# Telegram Bot 设置指南

## 1. 创建 Telegram Bot

1. 在 Telegram 中搜索 `@BotFather`
2. 发送 `/newbot` 命令
3. 按照提示输入你的 Bot 名称和用户名
4. 获得 Bot Token，形如：`123456789:ABCDEF1234567890abcdef1234567890ABC`

## 2. 获取 Chat ID

### 方法一：通过 Bot 获取

1. 向你创建的 Bot 发送任意消息
2. 在浏览器中访问：`https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. 在返回的 JSON 中找到 `"chat":{"id":XXXXXXXXX}` 中的数字，这就是你的 Chat ID

### 方法二：通过其他 Bot 获取

1. 在 Telegram 中搜索 `@userinfobot`
2. 发送 `/start` 命令，它会返回你的 Chat ID

## 3. 配置环境变量

在你的 `.env` 文件中添加：

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCDEF1234567890abcdef1234567890ABC
TELEGRAM_CHAT_ID=123456789
TELEGRAM_ENABLED=true
```

## 4. 测试功能

启动程序后，Telegram 集成会自动初始化。每小时会自动发送交易统计报告到你的 Telegram。

如果你想手动测试连接，可以修改代码调用 `testConnection()` 方法：

```typescript
import { getTelegramNotifier } from "./src/utils/telegram-notifier";

const notifier = getTelegramNotifier();
await notifier?.testConnection();
```

## 注意事项

- 确保 Bot Token 和 Chat ID 正确
- 如果是群组聊天，Chat ID 通常是负数
- 设置 `TELEGRAM_ENABLED=false` 可以禁用通知功能
- 消息发送失败不会影响交易程序的正常运行
