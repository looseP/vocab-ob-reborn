import type {
  L3GraphReadModel,
  L3ProposalBundle,
  L3ProposalConfirmResult,
  L3ProposalValidationResult,
  L3RecommendationAcceptResult,
  L3RecommendationBundle,
  L3RecommendationItemRow,
} from "@/domain";
import {
  applyGraphReadSuccess,
  applyImportSuccess,
  applyProposalConfirmSuccess,
  applyProposalRejectSuccess,
  applyProposalValidationResult,
  applyRecommendationAcceptSuccess,
  applyRecommendationGenerateSuccess,
  applyRecommendationRejectSuccess,
  type L3ImportProposalResponse,
} from "@/l3/frontend/contract";
import type { L3GraphStaleState } from "../state/l3CacheSignals";

export interface L3RuntimeSurfaceSmokeRow {
  surface: "manual" | "import" | "proposals" | "recommendations" | "graph" | "context" | "word" | "source";
  clientMethods: string[];
  readOnly: boolean;
  clearsActiveReadStale: boolean;
  marksActiveReadStale: boolean;
}

export interface ProposalReviewHandoff {
  proposalId: string | null;
  canOpenProposalReview: boolean;
}

export function importProposalReviewHandoff(result: L3ImportProposalResponse | null): ProposalReviewHandoff {
  const proposalId = typeof result?.proposal.id === "string" && result.proposal.id.trim() ? result.proposal.id : null;
  return { proposalId, canOpenProposalReview: Boolean(proposalId) };
}

export function recommendationProposalReviewHandoff(result: L3RecommendationAcceptResult | null): ProposalReviewHandoff {
  const proposalId = result?.proposal?.proposal.id ?? null;
  return { proposalId, canOpenProposalReview: Boolean(proposalId) };
}

export function graphStaleBannerText(staleState: L3GraphStaleState | null): string | null {
  if (!staleState) return null;
  return `Graph may be stale after proposal confirmation: ${staleState.reason}`;
}

export function shouldClearGraphStaleAfterRead(graph: L3GraphReadModel | null): boolean {
  if (!graph) return false;
  const transition = applyGraphReadSuccess(graph);
  return transition.cache.activeReadInvalidation === false && transition.refreshGraph === false && transition.createsActiveL3 === false;
}

export function graphEdgeRowsFromRead(graph: L3GraphReadModel): Array<{
  id: string;
  type: string;
  sourceNodeId: string;
  targetNodeId: string;
}> {
  return graph.edges.map((edge) => ({
    id: edge.id,
    type: edge.type,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
  }));
}

export function frontendCacheSignalMatrix(input: {
  importResult: L3ImportProposalResponse;
  proposalValidation: L3ProposalValidationResult;
  proposalConfirm: L3ProposalConfirmResult;
  proposalReject: L3ProposalBundle;
  recommendationGenerate: L3RecommendationBundle;
  recommendationAccept: L3RecommendationAcceptResult;
  recommendationReject: L3RecommendationItemRow;
  graphRead: L3GraphReadModel;
}) {
  return {
    importSuccess: applyImportSuccess(input.importResult).cache,
    proposalValidation: applyProposalValidationResult(input.proposalValidation).cache,
    proposalConfirm: applyProposalConfirmSuccess(input.proposalConfirm).cache,
    proposalReject: applyProposalRejectSuccess(input.proposalReject).cache,
    recommendationGenerate: applyRecommendationGenerateSuccess(input.recommendationGenerate).cache,
    recommendationAccept: applyRecommendationAcceptSuccess(input.recommendationAccept).cache,
    recommendationReject: applyRecommendationRejectSuccess(input.recommendationReject).cache,
    graphRead: applyGraphReadSuccess(input.graphRead).cache,
  };
}

export function frontendRuntimeSmokeMatrix(): L3RuntimeSurfaceSmokeRow[] {
  return [
    {
      surface: "manual",
      clientMethods: [
        "createSource",
        "createContext",
        "createOccurrence",
        "createContextLink",
        "deleteOccurrence",
        "deleteContextLink",
        "deleteSource",
        "deleteContext",
      ],
      readOnly: false,
      clearsActiveReadStale: false,
      marksActiveReadStale: true,
    },
    {
      surface: "import",
      clientMethods: ["createRawTextImport"],
      readOnly: false,
      clearsActiveReadStale: false,
      marksActiveReadStale: false,
    },
    {
      surface: "proposals",
      clientMethods: ["listProposals", "getProposal", "validateProposal", "confirmProposal", "rejectProposal"],
      readOnly: false,
      clearsActiveReadStale: false,
      marksActiveReadStale: true,
    },
    {
      surface: "recommendations",
      clientMethods: ["generateRecommendations", "listRecommendations", "getRecommendation", "acceptRecommendation", "rejectRecommendation"],
      readOnly: false,
      clearsActiveReadStale: false,
      marksActiveReadStale: false,
    },
    {
      surface: "graph",
      clientMethods: ["getGraph"],
      readOnly: true,
      clearsActiveReadStale: true,
      marksActiveReadStale: false,
    },
    {
      surface: "context",
      clientMethods: ["getContextDetail"],
      readOnly: true,
      clearsActiveReadStale: true,
      marksActiveReadStale: false,
    },
    {
      surface: "word",
      clientMethods: ["getWordSpace"],
      readOnly: true,
      clearsActiveReadStale: true,
      marksActiveReadStale: false,
    },
    {
      surface: "source",
      clientMethods: ["getSourceSpace"],
      readOnly: true,
      clearsActiveReadStale: true,
      marksActiveReadStale: false,
    },
  ];
}
