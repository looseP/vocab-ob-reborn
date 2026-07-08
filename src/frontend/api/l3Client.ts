import { createL3FrontendClient, type L3FrontendClient } from "@/l3/frontend/contract";

const DEFAULT_API_BASE_URL = "";

export function createBrowserL3Client(baseUrl = DEFAULT_API_BASE_URL, fetchImpl: typeof fetch = fetch): L3FrontendClient {
  return createL3FrontendClient({
    fetch: async (input, init) => {
      const response = await fetchImpl(`${baseUrl}${input}`, init);
      return {
        ok: response.ok,
        status: response.status,
        json: () => response.json(),
      };
    },
  });
}
