export type ApiErrorBody = {
  error?: string;
  code?: string;
  message?: string;
  details?: unknown;
  requestId?: string;
};

export class BrowserApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const error = isRecord(body) ? body as ApiErrorBody : {};
    const textMessage = typeof body === "string" && body.trim() ? body : undefined;
    super(error.message ?? error.error ?? textMessage ?? `Request failed with status ${status}`);
    this.name = "BrowserApiError";
    this.status = status;
    this.code = error.code;
    this.details = error.details;
    this.requestId = error.requestId;
    this.body = body;
  }
}

export type BrowserRequestOptions = RequestInit & {
  bearerToken?: string;
  parseJson?: boolean;
  /** 请求超时（毫秒）。默认 20s；0 表示不设超时。 */
  timeoutMs?: number;
};

export type BrowserResponse<T> = { data: T; status: number };
export type BrowserRequest = <T>(input: string, init?: BrowserRequestOptions) => Promise<T>;
export type BrowserResponseRequest = <T>(input: string, init?: BrowserRequestOptions) => Promise<BrowserResponse<T>>;

type BrowserRequestDependencies = {
  baseUrl?: string;
  fetch?: typeof fetch;
  cookie?: () => string;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const REQUESTED_WITH_VALUE = "VocabObservatory";

/** 默认请求超时：20s，避免慢网/挂起请求让 loading 无限转圈。 */
const DEFAULT_TIMEOUT_MS = 20000;

/** 业务请求收到 401（会话失效/过期）时派发的全局事件名。 */
export const AUTH_EXPIRED_EVENT = "vocab:auth:expired";

/** auth 路径自身的 401 属于"未登录"的正常语义，不派发会话过期事件。 */
const AUTH_PATH_PREFIX = "/api/auth/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function csrfTokenFromCookie(cookie: string): string | undefined {
  const entry = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("vocab_csrf="));
  if (!entry) return undefined;
  try {
    return decodeURIComponent(entry.slice("vocab_csrf=".length));
  } catch {
    return undefined;
  }
}

export function createBrowserResponseRequest(dependencies: BrowserRequestDependencies = {}): BrowserResponseRequest {
  const fetchImpl = dependencies.fetch ?? fetch;
  const readCookie = dependencies.cookie ?? (() => typeof document === "undefined" ? "" : document.cookie);
  const baseUrl = dependencies.baseUrl ?? "";

  return async <T>(input: string, init: BrowserRequestOptions = {}): Promise<BrowserResponse<T>> => {
    const { bearerToken, parseJson = true, timeoutMs = DEFAULT_TIMEOUT_MS, ...requestInit } = init;
    const method = (requestInit.method ?? "GET").toUpperCase();
    const headers = new Headers(requestInit.headers);
    headers.set("Accept", "application/json");
    headers.set("X-Requested-With", REQUESTED_WITH_VALUE);
    if (requestInit.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (bearerToken) headers.set("Authorization", `Bearer ${bearerToken}`);
    if (!SAFE_METHODS.has(method) && !bearerToken) {
      const csrfToken = csrfTokenFromCookie(readCookie());
      if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
    }

    // 超时 + 外部 signal（如列表竞态取消）合并：
    // 外部 signal 优先（调用方主动取消），timer 兜底超时中止。
    const controller = new AbortController();
    const outerSignal = requestInit.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
    }
    const onOuterAbort = () => controller.abort(outerSignal?.reason);
    if (outerSignal) {
      if (outerSignal.aborted) onOuterAbort();
      else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${input}`, {
        ...requestInit,
        method,
        credentials: "same-origin",
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      // 超时中止（外部 signal 未主动取消）→ 转成可读的请求超时错误
      if (controller.signal.aborted && !outerSignal?.aborted) {
        throw new BrowserApiError(0, { code: "TIMEOUT", message: "请求超时，请检查网络后重试" });
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
    if (response.status === 204) return { data: undefined as T, status: response.status };

    const rawBody = await response.text();
    let body: unknown = rawBody || undefined;
    if (parseJson && rawBody) {
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        body = rawBody;
      }
    }
    if (!response.ok) {
      // 业务请求 401 = 服务端会话失效/过期，通知全局兜底（BrowserSessionGate 处理）。
      if (response.status === 401 && !input.startsWith(AUTH_PATH_PREFIX) && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
      }
      throw new BrowserApiError(response.status, body);
    }
    return { data: body as T, status: response.status };
  };
}

export function createBrowserRequest(dependencies: BrowserRequestDependencies = {}): BrowserRequest {
  const request = createBrowserResponseRequest(dependencies);
  return async <T>(input: string, init?: BrowserRequestOptions): Promise<T> => (await request<T>(input, init)).data;
}
