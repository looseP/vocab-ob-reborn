import type { L3ProposalBundle, L3RecommendationItemRow } from "@/domain";
import type { L3PaginatedResponse } from "@/l3/frontend/contract";
import type { operations } from "./generated/openapi";

export type GeneratedL3ProposalListResponse = operations["listL3Proposals"]["responses"][200]["content"]["application/json"];
export type GeneratedL3ProposalDetailResponse = operations["getL3Proposal"]["responses"][200]["content"]["application/json"];
export type GeneratedL3RecommendationListResponse = operations["listL3Recommendations"]["responses"][200]["content"]["application/json"];
export type GeneratedL3RecommendationDetailResponse = operations["getL3Recommendation"]["responses"][200]["content"]["application/json"];

type Extends<Actual, Expected> = [Actual] extends [Expected] ? true : false;
type Assert<T extends true> = T;

type _ProposalListGeneratedToDomain = Assert<Extends<GeneratedL3ProposalListResponse, L3PaginatedResponse<L3ProposalBundle["proposal"]>>>;
type _ProposalListDomainToGenerated = Assert<Extends<L3PaginatedResponse<L3ProposalBundle["proposal"]>, GeneratedL3ProposalListResponse>>;
type _ProposalDetailGeneratedToDomain = Assert<Extends<GeneratedL3ProposalDetailResponse, L3ProposalBundle>>;
type _ProposalDetailDomainToGenerated = Assert<Extends<L3ProposalBundle, GeneratedL3ProposalDetailResponse>>;
type _RecommendationListGeneratedToDomain = Assert<Extends<GeneratedL3RecommendationListResponse, L3PaginatedResponse<L3RecommendationItemRow>>>;
type _RecommendationListDomainToGenerated = Assert<Extends<L3PaginatedResponse<L3RecommendationItemRow>, GeneratedL3RecommendationListResponse>>;
type _RecommendationDetailGeneratedToDomain = Assert<Extends<GeneratedL3RecommendationDetailResponse, L3RecommendationItemRow>>;
type _RecommendationDetailDomainToGenerated = Assert<Extends<L3RecommendationItemRow, GeneratedL3RecommendationDetailResponse>>;
