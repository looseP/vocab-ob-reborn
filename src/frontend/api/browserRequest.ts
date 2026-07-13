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
    const { bearerToken, parseJson = true, ...requestInit } = init;
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

    const response = await fetchImpl(`${baseUrl}${input}`, {
      ...requestInit,
      method,
      credentials: "same-origin",
      headers,
    });
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
    if (!response.ok) throw new BrowserApiError(response.status, body);
    return { data: body as T, status: response.status };
  };
}

export function createBrowserRequest(dependencies: BrowserRequestDependencies = {}): BrowserRequest {
  const request = createBrowserResponseRequest(dependencies);
  return async <T>(input: string, init?: BrowserRequestOptions): Promise<T> => (await request<T>(input, init)).data;
}
