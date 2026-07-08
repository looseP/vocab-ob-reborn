import { useEffect, useMemo, useState } from "react";
import type { L3ProposalBundle, L3ProposalConfirmResult, L3ProposalItemRow, L3ProposalRow, L3ProposalStatus, L3ProposalValidationResult } from "@/domain";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import { L3NavigationActions } from "../components/L3NavigationActions";
import {
  applyProposalConfirmSuccess,
  applyProposalRejectSuccess,
  applyProposalValidationResult,
  isNormalizedL3Error,
  normalizeL3TransportError,
  proposalActionsForStatus,
  type L3FrontendClient,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import { hasValidationErrors, sortProposalItems, summarizeProposalItem } from "../viewModels/l3ProposalViewModel";
import {
  navigationAction,
  type L3NavigationAction,
  type L3NavigationIntent,
} from "../viewModels/l3NavigationViewModel";

interface L3ProposalPageProps {
  client: L3FrontendClient;
  selectedProposalId: string | null;
  onSelectProposal(proposalId: string | null): void;
  onConfirmed(result: L3ProposalConfirmResult): void;
  onNavigate(intent: L3NavigationIntent): void;
}

type ProposalFilter = L3ProposalStatus | "all";
type ReviewStatus = "idle" | "loading" | "validating" | "confirming" | "rejecting";

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

function proposalTitle(proposal: L3ProposalRow): string {
  return proposal.title || proposal.summary || proposal.id;
}

function formatValidationErrors(item: L3ProposalItemRow): string {
  return JSON.stringify(item.validation_errors);
}

function activeEntityNavigationActions(result: L3ProposalConfirmResult | null): L3NavigationAction[] {
  if (!result) return [];
  const actions: L3NavigationAction[] = [navigationAction("Open Graph", { target: "graph", query: {} })];
  for (const entity of result.activeEntities) {
    if (entity.activeEntityType === "context") {
      actions.push(navigationAction("Open Context", { target: "context", contextId: entity.activeEntityId }));
    } else if (entity.activeEntityType === "source") {
      actions.push(navigationAction("Open Source Space", { target: "source", sourceId: entity.activeEntityId }));
    }
  }
  return actions;
}

export function L3ProposalPage({ client, selectedProposalId, onSelectProposal, onConfirmed, onNavigate }: L3ProposalPageProps) {
  const [filter, setFilter] = useState<ProposalFilter>("pending");
  const [proposals, setProposals] = useState<L3ProposalRow[]>([]);
  const [detail, setDetail] = useState<L3ProposalBundle | null>(null);
  const [validation, setValidation] = useState<L3ProposalValidationResult | null>(null);
  const [confirmResult, setConfirmResult] = useState<L3ProposalConfirmResult | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [status, setStatus] = useState<ReviewStatus>("idle");
  const [error, setError] = useState<NormalizedL3Error | null>(null);

  const actions = useMemo(() => proposalActionsForStatus(detail?.proposal.status ?? "pending"), [detail?.proposal.status]);
  const orderedItems = useMemo(() => sortProposalItems(detail?.items ?? []), [detail?.items]);
  const isBusy = status !== "idle";

  const loadProposals = async () => {
    setStatus("loading");
    setError(null);
    try {
      const response = await client.listProposals({ ...(filter === "all" ? {} : { status: filter }), limit: 50 });
      setProposals(response.items);
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  const loadDetail = async (proposalId: string) => {
    setStatus("loading");
    setError(null);
    setValidation(null);
    setConfirmResult(null);
    setReviewNote("");
    try {
      const response = await client.getProposal(proposalId);
      setDetail(response);
      onSelectProposal(response.proposal.id);
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      setDetail(null);
    } finally {
      setStatus("idle");
    }
  };

  useEffect(() => {
    void loadProposals();
  }, [filter]);

  useEffect(() => {
    if (selectedProposalId) void loadDetail(selectedProposalId);
  }, [selectedProposalId]);

  const validate = async () => {
    if (!detail) return;
    setStatus("validating");
    setError(null);
    setConfirmResult(null);
    try {
      const response = await client.validateProposal(detail.proposal.id);
      applyProposalValidationResult(response);
      setValidation(response);
      setDetail({ proposal: response.proposal, items: response.items });
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  const confirm = async () => {
    if (!detail) return;
    setStatus("confirming");
    setError(null);
    setConfirmResult(null);
    try {
      const response = await client.confirmProposal(detail.proposal.id);
      applyProposalConfirmSuccess(response);
      setConfirmResult(response);
      setValidation(null);
      setReviewNote("");
      setDetail({ proposal: response.proposal, items: response.items });
      onConfirmed(response);
      await loadProposals();
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  const reject = async () => {
    if (!detail) return;
    setStatus("rejecting");
    setError(null);
    setConfirmResult(null);
    try {
      const response = await client.rejectProposal(detail.proposal.id, reviewNote.trim() || null);
      applyProposalRejectSuccess(response);
      setDetail(response);
      setValidation(null);
      setConfirmResult(null);
      setReviewNote("");
      await loadProposals();
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  return (
    <section className="l3-page">
      <p className="eyebrow">Proposal Review</p>
      <h2>Validate, confirm, or reject pending L3 proposals.</h2>
      <p className="lede">Confirm is the only action here that upgrades proposal items into active L3 and marks graph/read views stale.</p>

      <L3ErrorMessage error={error} />

      <div className="proposal-workspace">
        <aside className="proposal-list-panel">
          <div className="toolbar">
            <label>
              Status
              <select disabled={isBusy} onChange={(event) => setFilter(event.target.value as ProposalFilter)} value={filter}>
                <option value="pending">pending</option>
                <option value="confirmed">confirmed</option>
                <option value="rejected">rejected</option>
                <option value="canceled">canceled</option>
                <option value="all">all</option>
              </select>
            </label>
            <button disabled={isBusy} onClick={() => void loadProposals()} type="button">{status === "loading" ? "Refreshing..." : "Refresh"}</button>
          </div>
          <div className="proposal-list">
            {proposals.length === 0 ? <p className="empty-state">No proposals for this filter.</p> : null}
            {proposals.map((proposal) => (
              <button
                className={proposal.id === detail?.proposal.id ? "proposal-row active" : "proposal-row"}
                disabled={isBusy}
                key={proposal.id}
                onClick={() => void loadDetail(proposal.id)}
                type="button"
              >
                <strong>{proposalTitle(proposal)}</strong>
                <span>{proposal.status} / {proposal.source_type}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="proposal-detail-panel">
          {!detail ? (
            <div className="placeholder-panel">
              <strong>{status === "loading" ? "Loading proposal..." : "Select a proposal."}</strong>
              <span>Pending proposal items are review candidates, not active evidence.</span>
            </div>
          ) : (
            <>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">{detail.proposal.status}</p>
                  <h3>{proposalTitle(detail.proposal)}</h3>
                  <span>{detail.items.length} item(s) / {detail.proposal.source_type}</span>
                </div>
                <div className="action-row">
                  <button disabled={!actions.canValidate || isBusy} onClick={() => void validate()} type="button">
                    {status === "validating" ? "Validating..." : "Validate"}
                  </button>
                  <button disabled={!actions.canConfirm || isBusy} onClick={() => void confirm()} type="button">
                    {status === "confirming" ? "Confirming..." : "Confirm"}
                  </button>
                  <button className="danger-button" disabled={!actions.canReject || isBusy} onClick={() => void reject()} type="button">
                    {status === "rejecting" ? "Rejecting..." : "Reject"}
                  </button>
                </div>
              </div>

              <label className="review-note">
                Review note
                <textarea onChange={(event) => setReviewNote(event.target.value)} placeholder="Optional reject note" value={reviewNote} />
              </label>

              {validation ? (
                <div className={validation.valid ? "validation-panel valid" : "validation-panel invalid"}>
                  <strong>{validation.valid ? "Validation passed" : "Validation feedback"}</strong>
                  <span>{validation.valid ? "Proposal can be confirmed or rejected." : "Review item-level issues before confirming."}</span>
                  {!validation.valid ? (
                    <ul>
                      {validation.errors.map((issue) => (
                        <li key={`${issue.itemId}-${issue.field}-${issue.message}`}>
                          #{issue.ordinal} {issue.itemType} / {issue.field}: {issue.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {confirmResult ? (
                <div className="validation-panel valid">
                  <strong>Active L3 entities created</strong>
                  <ul>
                    {confirmResult.activeEntities.map((entity) => (
                      <li key={`${entity.itemId}-${entity.activeEntityId}`}>
                        {entity.activeEntityType}: {entity.activeEntityId}
                      </li>
                    ))}
                  </ul>
                  <L3NavigationActions actions={activeEntityNavigationActions(confirmResult)} onNavigate={onNavigate} />
                </div>
              ) : null}

              <div className="proposal-items">
                {orderedItems.map((item) => (
                  <article className="proposal-item" key={item.id}>
                    <div>
                      <strong>#{item.ordinal} {item.item_type}</strong>
                      <span>{item.status}{item.active_entity_id ? ` / active ${item.active_entity_type}: ${item.active_entity_id}` : ""}</span>
                    </div>
                    <p>{summarizeProposalItem(item)}</p>
                    {hasValidationErrors(item) ? <code>{formatValidationErrors(item)}</code> : null}
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
