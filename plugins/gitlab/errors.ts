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
  if (!detail) {
    try {
      const parsed = JSON.parse(stdout);
      const error = parsed.error ?? parsed;
      detail = [error.type, error.code, error.message].filter((v) => v !== undefined).join(" ");
    } catch {}
  }
  const prefix = `${label}（退出码 ${code}${status ? `，HTTP ${status}` : ""}）：`;
  const error = classified(detail, status);
  error.message = prefix + diagnostic(detail || "没有错误详情", Math.max(0, 300 - prefix.length));
  return error;
}

export async function postEvent(url: string, init: RequestInit): Promise<Response> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const cause = error as { message?: string; cause?: { code?: string; message?: string } };
    throw classified(
      `中台 ${host}：${cause.cause?.code ?? ""} ${cause.cause?.message ?? cause.message ?? String(error)}`,
    );
  }
  if (!response.ok) throw classified(`中台 ${host} 接收失败（HTTP ${response.status}）`, response.status);
  return response;
}
