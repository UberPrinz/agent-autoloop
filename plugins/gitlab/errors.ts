export class TemporaryError extends Error {}
export class AccessError extends Error {}

// Redact before truncating: cutting a credential first can hide its identifying prefix.
export function diagnostic(text: string, limit = 300): string {
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
      try {
        const value = new URL(url);
        value.username = "";
        value.password = "";
        value.search = "";
        value.hash = "";
        return value.toString();
      } catch {
        return "[网址已隐藏]";
      }
    })
    .replace(/\b(?:glpat-|[ut]-)[a-zA-Z0-9_.-]+/g, "[令牌已隐藏]")
    .replace(
      /\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+)?[^\s,;"'\r\n}]+/gi,
      "Authorization: [已隐藏]",
    )
    .replace(/\b(?:[a-z_]*token|[a-z_]*secret|api[_-]?key|password)["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi, "token=[已隐藏]")
    .replace(/\bBearer\s+[^\s,;"'}]+/gi, "Bearer [已隐藏]")
    .trim()
    .slice(-limit);
}

export function classified(message: string, status?: number): Error {
  const text = diagnostic(message);
  if (
    status === 401 ||
    status === 403 ||
    /\b(unauthorized|forbidden)\b|["']?type["']?\s*:\s*["']?(authentication|authorization)\b|^(authentication|authorization)\b(?!\s*:)|登录失效|权限不足/i.test(
      message,
    )
  )
    return new AccessError(text);
  if (
    status === 429 ||
    (status !== undefined && status >= 500) ||
    /\brate_limit\b|\b99991400\b|\bHTTP(?:\/[\d.]+)?[ :=]+(?:429|5\d\d)\b/i.test(message) ||
    /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|proxyconnect|proxy connection|connection refused|connection reset|timed? ?out|timeout|no such host|temporary failure in name resolution/i.test(
      message,
    )
  )
    return new TemporaryError(text);
  return new Error(text);
}

export function cliFailure(
  label: string,
  code: string | number | null,
  stderr: string,
  stdout: string,
  status?: number,
): Error {
  let detail = stderr.trim();
  let errorCode: unknown;
  try {
    const parsed = JSON.parse(detail || stdout);
    const error = parsed.error ?? parsed;
    errorCode = error.code;
    if (!detail) detail = [error.type, error.code, error.message].filter((v) => v !== undefined).join(" ");
  } catch {}
  // CLI error codes in the HTTP range are transport evidence; other service codes retain their own meaning.
  if (
    status === undefined &&
    typeof errorCode === "number" &&
    ([401, 403, 429].includes(errorCode) || (errorCode >= 500 && errorCode <= 599))
  )
    status = errorCode;
  const prefix = `${label}（退出码 ${code}${status ? `，HTTP ${status}` : ""}）：`;
  const error = classified(detail, status);
  error.message = prefix + diagnostic(detail || "没有错误详情", Math.max(0, 300 - prefix.length));
  return error;
}

export async function postEvent(url: string, init: RequestInit): Promise<unknown> {
  const host = new URL(url).host;
  try {
    const response = await fetch(url, init);
    if (!response.ok) throw classified(`中台 ${host} 接收失败（HTTP ${response.status}）`, response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof AccessError || error instanceof TemporaryError) throw error;
    const cause = error as { message?: string; cause?: { code?: string; message?: string } };
    throw classified(
      `中台 ${host}：${cause.cause?.code ?? ""} ${cause.cause?.message ?? cause.message ?? String(error)}`,
    );
  }
}
