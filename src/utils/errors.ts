export function isUnknownOrderError(error: unknown): boolean {
  const message = extractMessage(error);
  if (!message) return false;
  return message.includes("Unknown order") || message.includes("code\":-2011");
}

export function extractMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isRateLimitError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isFinite(status) && status === 429) {
      return true;
    }
  }
  if (typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 429 || code === "429") {
      return true;
    }
  }
  const message = extractMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("request rate")
  );
}

export function isInsufficientMarginError(error: unknown): boolean {
  if (!error) return false;
  
  // 检查错误代码
  if (typeof error === "object" && "code" in error) {
    const code = Number((error as { code?: unknown }).code);
    // -2019: MARGIN_NOT_SUFFICIENT
    // -2027: MAX_LEVERAGE_RATIO (Exceeded the maximum allowable position at current leverage)
    // -2028: MIN_LEVERAGE_RATIO (Leverage is smaller than permitted: insufficient margin balance)
    if (code === -2019 || code === -2027 || code === -2028) {
      return true;
    }
  }
  
  // 检查错误消息
  const message = extractMessage(error).toLowerCase();
  return (
    message.includes("margin") && message.includes("insufficient") ||
    message.includes("margin is insufficient") ||
    message.includes("insufficient margin") ||
    message.includes("exceed") && message.includes("leverage") ||
    message.includes("maximum allowable position") ||
    message.includes("insufficient margin balance")
  );
}
