import { createL3FrontendClient, type L3FrontendClient } from "@/l3/frontend/contract";
import { BrowserApiError, createBrowserResponseRequest } from "./browserRequest";
import { adaptCursorPage } from "./pagination";

const DEFAULT_API_BASE_URL = "";

export function createBrowserL3Client(baseUrl = DEFAULT_API_BASE_URL, fetchImpl: typeof fetch = fetch): L3FrontendClient {
  const request = createBrowserResponseRequest({ baseUrl, fetch: fetchImpl });
  const client = createL3FrontendClient({
    fetch: async (input, init) => {
      try {
        const response = await request<unknown>(input, init);
        return { ok: true, status: response.status, json: async () => response.data };
      } catch (error) {
        if (!(error instanceof BrowserApiError)) throw error;
        return { ok: false, status: error.status, json: async () => error.body };
      }
    },
  });
  return {
    ...client,
    listProposals: async params => adaptCursorPage(await client.listProposals(params)),
    listRecommendations: async params => adaptCursorPage(await client.listRecommendations(params)),
  };
}
