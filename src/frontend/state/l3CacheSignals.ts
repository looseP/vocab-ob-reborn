import { applyProposalConfirmSuccess, graphStateAfterConfirm, type L3CacheSignal } from "@/l3/frontend/contract";
import type { L3ProposalConfirmResult } from "@/domain";

export const PHASE_4C_CACHE_POLICY: L3CacheSignal = {
  keys: [],
  activeReadInvalidation: false,
  proposalInvalidation: false,
  recommendationInvalidation: false,
  reason: "phase_4c_local_state_no_global_cache",
};

export interface L3GraphStaleState {
  state: ReturnType<typeof graphStateAfterConfirm>;
  reason: string;
  activeEntities: L3ProposalConfirmResult["activeEntities"];
}

export type L3ActiveReadStaleState = L3GraphStaleState;

export function markGraphStaleAfterProposalConfirm(result: L3ProposalConfirmResult): L3GraphStaleState {
  return {
    state: graphStateAfterConfirm(),
    reason: applyProposalConfirmSuccess(result).cache.reason,
    activeEntities: result.activeEntities,
  };
}

export function markActiveReadStaleAfterProposalConfirm(result: L3ProposalConfirmResult): L3ActiveReadStaleState {
  return markGraphStaleAfterProposalConfirm(result);
}

export function markActiveReadStaleAfterManualCommand(reason = "manual_active_l3_changed"): L3ActiveReadStaleState {
  return {
    state: "staleAfterConfirm",
    reason,
    activeEntities: [],
  };
}

export function markActiveReadStaleAfterManualCreate(reason = "manual_active_l3_created"): L3ActiveReadStaleState {
  return markActiveReadStaleAfterManualCommand(reason);
}
