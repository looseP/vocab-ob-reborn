import { createBrowserRequest } from "./browserRequest";

const request = createBrowserRequest();

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  return request<T>(path.startsWith("/api") ? path : `/api${path}`, options);
}
