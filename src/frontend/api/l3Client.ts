import { createL3FrontendClient, type L3FrontendClient } from "@/l3/frontend/contract";
import { browserCsrfHeaders } from "./browserAuth";

const DEFAULT_API_BASE_URL = "";

export function createBrowserL3Client(baseUrl = DEFAULT_API_BASE_URL, fetchImpl: typeof fetch = fetch): L3FrontendClient {
  return createL3FrontendClient({
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";
      const response = await fetchImpl(`${baseUrl}${input}`, {
        ...init,
        credentials: "same-origin",
        headers: { ...init?.headers, ...browserCsrfHeaders(method) },
      });
      return {
        ok: response.ok,
        status: response.status,
        json: () => response.json(),
      };
    },
  });
}
