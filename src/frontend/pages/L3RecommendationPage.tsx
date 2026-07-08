import { useEffect, useMemo, useState } from "react";
import type { L3RecommendationAcceptResult, L3RecommendationBundle, L3RecommendationItemRow, L3RecommendationStatus, L3RecommendationType } from "@/domain";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import {
  isNormalizedL3Error,
  normalizeL3TransportError,
  type L3FrontendClient,
  type L3RecommendationGenerateInput,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import {
  applyRecommendationAcceptUiResult,
  applyRecommendationGenerateUiResult,
  applyRecommendationRejectUiResult,
  buildRecommendationGeneratePayload,
  compactJson,
  proposalIdFromRecommendationAccept,
  recommendationAcceptMessage,
  recommendationActionsForStatus,
  recommendationEvidencePreview,
  recommendationModes,
  recommendationPayloadPreview,
  recommendationRunStatsPreview,
  recommendationStatuses,
  recommendationTypes,
  summarizeRecommendationItem,
} from "../viewModels/l3RecommendationViewModel";

interface L3RecommendationPageProps {
  client: L3FrontendClient;
  onOpenProposal(proposalId: string): void;
}

type RecommendationFilter = L3RecommendationStatus | "all";
type RecommendationTypeFilter = L3RecommendationType | "all";
type WorkStatus = "idle" | "generating" | "loading" | "accepting" | "rejecting" | "refreshing";

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

function updateItem(items: L3RecommendationItemRow[], updated: L3RecommendationItemRow): L3RecommendationItemRow[] {
  return items.map((item) => (item.id === updated.id ? updated : item));
}

export function L3RecommendationPage({ client, onOpenProposal }: L3RecommendationPageProps) {
  const [mode, setMode] = useState<L3RecommendationGenerateInput["mode"]>("gap_scan");
  const [wordbookId, setWordbookId] = useState("");
  const [seedSlug, setSeedSlug] = useState("");
  const [limit, setLimit] = useState("20");
  const [horizonDays, setHorizonDays] = useState("7");
  const [dryRun, setDryRun] = useState(false);
  const [statusFilter, setStatusFilter] = useState<RecommendationFilter>("pending");
  const [typeFilter, setTypeFilter] = useState<RecommendationTypeFilter>("all");
  const [listLimit, setListLimit] = useState("50");
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [items, setItems] = useState<L3RecommendationItemRow[]>([]);
  const [selectedItem, setSelectedItem] = useState<L3RecommendationItemRow | null>(null);
  const [generateResult, setGenerateResult] = useState<L3RecommendationBundle | null>(null);
  const [acceptResult, setAcceptResult] = useState<L3RecommendationAcceptResult | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [status, setStatus] = useState<WorkStatus>("idle");
  const [error, setError] = useState<NormalizedL3Error | null>(null);

  const isBusy = status !== "idle";
  const itemActions = useMemo(() => recommendationActionsForStatus(selectedItem?.status ?? "pending"), [selectedItem?.status]);
  const proposalId = proposalIdFromRecommendationAccept(acceptResult);

  const loadRecommendations = async (requestedCursor: string | null = null) => {
    setStatus("loading");
    setError(null);
    try {
      const response = await client.listRecommendations({
        ...(statusFilter === "all" ? {} : { status: statusFilter }),
        ...(typeFilter === "all" ? {} : { recommendationType: typeFilter }),
        limit: listLimit.trim() ? Number(listLimit) : 50,
        ...(requestedCursor ? { cursor: requestedCursor } : {}),
      });
      setItems(response.items);
      setCursor(response.cursor);
      setNextCursor(response.nextCursor);
      if (response.items.length > 0) {
        setSelectedItem((current) => response.items.find((item) => item.id === current?.id) ?? response.items[0] ?? null);
      } else {
        setSelectedItem(null);
      }
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  useEffect(() => {
    void loadRecommendations(null);
  }, [statusFilter, typeFilter]);

  const generate = async () => {
    setError(null);
    setGenerateResult(null);
    setAcceptResult(null);

    let payload: L3RecommendationGenerateInput;
    try {
      payload = buildRecommendationGeneratePayload({ mode, wordbookId, seedSlug, limit, horizonDays, dryRun });
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      return;
    }

    setStatus("generating");
    try {
      const response = await client.generateRecommendations(payload);
      applyRecommendationGenerateUiResult(response);
      setGenerateResult(response);
      setItems(response.items);
      setSelectedItem(response.items[0] ?? null);
      setCursor(null);
      setNextCursor(null);
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  const refreshSelected = async () => {
    if (!selectedItem) return;
    setStatus("refreshing");
    setError(null);
    try {
      const response = await client.getRecommendation(selectedItem.id);
      setSelectedItem(response);
      setItems((current) => updateItem(current, response));
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  const accept = async () => {
    if (!selectedItem) return;
    setStatus("accepting");
    setError(null);
    setAcceptResult(null);
    try {
      const response = await client.acceptRecommendation(selectedItem.id);
      applyRecommendationAcceptUiResult(response);
      setAcceptResult(response);
      setSelectedItem(response.item);
      setItems((current) => updateItem(current, response.item));
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  const reject = async () => {
    if (!selectedItem) return;
    setStatus("rejecting");
    setError(null);
    setAcceptResult(null);
    try {
      const response = await client.rejectRecommendation(selectedItem.id, reviewNote.trim() || null);
      applyRecommendationRejectUiResult(response);
      setSelectedItem(response);
      setItems((current) => updateItem(current, response));
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  return (
    <section className="l3-page">
      <p className="eyebrow">Recommendation Queue</p>
      <h2>Generate, review, accept, or reject L3 recommendation candidates.</h2>
      <p className="lede">Recommendations are candidate actions. Accepting a link gap creates a proposal bridge, not an active link.</p>

      <div className="l3-form">
        <div className="form-row">
          <label>
            Mode
            <select disabled={isBusy} onChange={(event) => setMode(event.target.value as L3RecommendationGenerateInput["mode"])} value={mode}>
              {recommendationModes.map((modeOption) => (
                <option key={modeOption} value={modeOption}>{modeOption}</option>
              ))}
            </select>
          </label>
          <label>
            Wordbook id
            <input disabled={isBusy} onChange={(event) => setWordbookId(event.target.value)} placeholder="optional" value={wordbookId} />
          </label>
          <label>
            Seed slug
            <input disabled={isBusy} onChange={(event) => setSeedSlug(event.target.value)} placeholder="optional" value={seedSlug} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Limit
            <input disabled={isBusy} inputMode="numeric" onChange={(event) => setLimit(event.target.value)} value={limit} />
          </label>
          <label>
            Horizon days
            <input disabled={isBusy} inputMode="numeric" onChange={(event) => setHorizonDays(event.target.value)} value={horizonDays} />
          </label>
          <label className="checkbox-label">
            <input checked={dryRun} disabled={isBusy} onChange={(event) => setDryRun(event.target.checked)} type="checkbox" />
            Dry run
          </label>
        </div>
        <button disabled={isBusy} onClick={() => void generate()} type="button">
          {status === "generating" ? "Generating..." : "Generate recommendations"}
        </button>
      </div>

      <L3ErrorMessage error={error} />

      {generateResult ? (
        <div className="l3-result-panel">
          <p className="eyebrow">{generateResult.run.id === "dry-run" ? "Dry Run Result" : "Recommendation Run"}</p>
          <h3>{generateResult.run.mode} / {generateResult.run.status}</h3>
          <span>Generated recommendation candidates only. No active L3 rows were written.</span>
          <dl className="result-meta">
            <div>
              <dt>Run</dt>
              <dd>{generateResult.run.id}</dd>
            </div>
            <div>
              <dt>Stats</dt>
              <dd>{recommendationRunStatsPreview(generateResult.stats)}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="proposal-workspace">
        <aside className="proposal-list-panel">
          <div className="toolbar">
            <label>
              Status
              <select disabled={isBusy} onChange={(event) => setStatusFilter(event.target.value as RecommendationFilter)} value={statusFilter}>
                <option value="all">all</option>
                {recommendationStatuses.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              Type
              <select disabled={isBusy} onChange={(event) => setTypeFilter(event.target.value as RecommendationTypeFilter)} value={typeFilter}>
                <option value="all">all</option>
                {recommendationTypes.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              Limit
              <input disabled={isBusy} inputMode="numeric" onChange={(event) => setListLimit(event.target.value)} value={listLimit} />
            </label>
            <button disabled={isBusy} onClick={() => void loadRecommendations(null)} type="button">
              {status === "loading" ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          <div className="proposal-list">
            {items.length === 0 ? <p className="empty-state">No recommendations for this filter. Generate candidates to start review.</p> : null}
            {items.map((item) => (
              <button
                className={item.id === selectedItem?.id ? "proposal-row active" : "proposal-row"}
                disabled={isBusy}
                key={item.id}
                onClick={() => {
                  setSelectedItem(item);
                  setAcceptResult(null);
                  setError(null);
                }}
                type="button"
              >
                <strong>{item.title}</strong>
                <span>{item.status} / {item.recommendation_type}</span>
              </button>
            ))}
          </div>
          <div className="action-row">
            <button disabled={isBusy || !nextCursor} onClick={() => void loadRecommendations(nextCursor)} type="button">
              Next page
            </button>
            {cursor ? <span className="contract-note">Cursor: {cursor}</span> : null}
          </div>
        </aside>

        <div className="proposal-detail-panel">
          {!selectedItem ? (
            <div className="placeholder-panel">
              <strong>Select a recommendation.</strong>
              <span>Accepted candidates remain non-active until any proposal bridge is confirmed.</span>
            </div>
          ) : (
            <>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">{selectedItem.status}</p>
                  <h3>{selectedItem.title}</h3>
                  <span>{selectedItem.recommendation_type} / score {selectedItem.priority_score} / confidence {selectedItem.confidence}</span>
                </div>
                <div className="action-row">
                  <button disabled={isBusy} onClick={() => void refreshSelected()} type="button">
                    {status === "refreshing" ? "Refreshing..." : "Refresh item"}
                  </button>
                  <button disabled={!itemActions.canAccept || isBusy} onClick={() => void accept()} type="button">
                    {status === "accepting" ? "Accepting..." : "Accept"}
                  </button>
                  <button className="danger-button" disabled={!itemActions.canReject || isBusy} onClick={() => void reject()} type="button">
                    {status === "rejecting" ? "Rejecting..." : "Reject"}
                  </button>
                </div>
              </div>

              <p>{selectedItem.summary}</p>
              <label className="review-note">
                Review note
                <textarea onChange={(event) => setReviewNote(event.target.value)} placeholder="Optional reject note" value={reviewNote} />
              </label>

              <dl className="result-meta">
                <div>
                  <dt>ID</dt>
                  <dd>{selectedItem.id}</dd>
                </div>
                <div>
                  <dt>Run</dt>
                  <dd>{selectedItem.run_id}</dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd>{compactJson(selectedItem.reason_codes, 220)}</dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd>{recommendationEvidencePreview(selectedItem)}</dd>
                </div>
                <div>
                  <dt>Payload</dt>
                  <dd>{recommendationPayloadPreview(selectedItem)}</dd>
                </div>
                <div>
                  <dt>Accepted proposal</dt>
                  <dd>{selectedItem.accepted_proposal_id ?? "none"}</dd>
                </div>
              </dl>

              <div className="validation-panel invalid">
                <strong>{selectedItem.recommendation_type === "link_gap" ? "Accept creates a proposal bridge." : "Accept records a future action payload."}</strong>
                <span>{selectedItem.recommendation_type === "link_gap" ? "Open Proposal Review and confirm before an active link exists." : "No active L3 rows are created by accepting this item."}</span>
              </div>

              {acceptResult ? (
                <div className={acceptResult.proposal ? "validation-panel valid" : "validation-panel invalid"}>
                  <strong>{recommendationAcceptMessage(acceptResult)}</strong>
                  {acceptResult.proposal ? (
                    <>
                      <span>{acceptResult.proposal.proposal.id} / {acceptResult.proposal.proposal.status}</span>
                      <div className="action-row">
                        <button disabled={!proposalId} onClick={() => proposalId && onOpenProposal(proposalId)} type="button">
                          Open proposal review
                        </button>
                      </div>
                    </>
                  ) : (
                    <code>{compactJson(acceptResult.actionPayload ?? acceptResult.item, 300)}</code>
                  )}
                </div>
              ) : null}

              <div className="proposal-item">
                <strong>{summarizeRecommendationItem(selectedItem)}</strong>
                <span>Created {selectedItem.created_at}; updated {selectedItem.updated_at}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
