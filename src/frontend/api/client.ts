import { createBrowserRequest } from "./browserRequest";
import type { BrowserRequestOptions } from "./browserRequest";

const request = createBrowserRequest();

export async function apiFetch<T>(path: string, options?: BrowserRequestOptions): Promise<T> {
  return request<T>(path.startsWith("/api") ? path : `/api${path}`, options);
}
