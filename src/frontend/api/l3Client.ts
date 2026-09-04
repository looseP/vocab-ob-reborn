import { createL3FrontendClient, type L3FrontendClient } from "@/l3/frontend/contract";
import type {
  GeneratedL3ProposalDetailResponse,
  GeneratedL3ProposalListResponse,
  GeneratedL3RecommendationDetailResponse,
  GeneratedL3RecommendationListResponse,
} from "./l3ResponseTypes";
import { BrowserApiError, createBrowserResponseRequest } from "./browserRequest";
import { adaptCursorPage } from "./pagination";

const DEFAULT_API_BASE_URL = "";

type GeneratedL3ReadClient = {
  listProposals: (...args: Parameters<L3FrontendClient["listProposals"]>) => Promise<GeneratedL3ProposalListResponse>;
  getProposal: (...args: Parameters<L3FrontendClient["getProposal"]>) => Promise<GeneratedL3ProposalDetailResponse>;
  listRecommendations: (...args: Parameters<L3FrontendClient["listRecommendations"]>) => Promise<GeneratedL3RecommendationListResponse>;
  getRecommendation: (...args: Parameters<L3FrontendClient["getRecommendation"]>) => Promise<GeneratedL3RecommendationDetailResponse>;
};

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
  const generatedReadClient = {
    listProposals: async params => adaptCursorPage(await client.listProposals(params)),
    getProposal: client.getProposal,
    listRecommendations: async params => adaptCursorPage(await client.listRecommendations(params)),
    getRecommendation: client.getRecommendation,
  } satisfies GeneratedL3ReadClient;

  return {
    ...client,
    ...generatedReadClient,
  };
}
