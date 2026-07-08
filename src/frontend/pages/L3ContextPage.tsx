import { useEffect, useState, type FormEvent } from "react";
import type { L3ContextDetail } from "@/domain";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import { L3NavigationActions } from "../components/L3NavigationActions";
import {
  isNormalizedL3Error,
  normalizeL3TransportError,
  type L3FrontendClient,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import type { L3ActiveReadStaleState } from "../state/l3CacheSignals";
import {
  applySpaceReadUiResult,
  buildContextLookupPayload,
  compactSpaceJson,
  contextEmptyMessages,
  contextPreview,
  contextStatsRows,
  linkSummary,
  occurrenceSummary,
  readStaleBannerText,
  shouldClearReadStaleAfterSpaceRead,
  sourceLabel,
} from "../viewModels/l3SpaceViewModel";
import {
  contextSourceNavigationAction,
  linkTargetNavigationAction,
  type L3ContextHandoff,
  occurrenceWordNavigationAction,
  type L3NavigationIntent,
} from "../viewModels/l3NavigationViewModel";

interface L3ContextPageProps {
  client: L3FrontendClient;
  handoff: L3ContextHandoff | null;
  staleState: L3ActiveReadStaleState | null;
  onReadRefreshed(): void;
  onNavigate(intent: L3NavigationIntent): void;
}

type WorkStatus = "idle" | "loading";

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

export function L3ContextPage({ client, handoff, staleState, onReadRefreshed, onNavigate }: L3ContextPageProps) {
  const [contextId, setContextId] = useState("");
  const [detail, setDetail] = useState<L3ContextDetail | null>(null);
  const [status, setStatus] = useState<WorkStatus>("idle");
  const [error, setError] = useState<NormalizedL3Error | null>(null);
  const isBusy = status !== "idle";
  const staleText = readStaleBannerText(staleState);

  useEffect(() => {
    if (!handoff) return;
    setContextId(handoff.contextId);
  }, [handoff?.nonce]);

  const loadContext = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setError(null);

    let payload;
    try {
      payload = buildContextLookupPayload({ contextId });
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      return;
    }

    setStatus("loading");
    try {
      const response = await client.getContextDetail(payload.contextId);
      const transition = applySpaceReadUiResult(response, false);
      setDetail(response);
      setContextId(response.context.id);
      if (shouldClearReadStaleAfterSpaceRead(transition)) onReadRefreshed();
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  return (
    <section className="l3-page space-page">
      <p className="eyebrow">Context Detail</p>
      <h2>Read one active L3 context without mutating active state.</h2>
      <p className="lede">Lookup a context by id through the shared L3 client. This page is read-only and never creates proposals, recommendations, imports, or active L3 rows.</p>

      {staleText ? (
        <div className="validation-panel invalid">
          <strong>L3 read data may be stale after proposal confirmation.</strong>
          <span>{staleText}</span>
          <div className="action-row">
            <button disabled={isBusy} onClick={() => void loadContext()} type="button">
              {status === "loading" ? "Refreshing..." : "Refresh context"}
            </button>
          </div>
        </div>
      ) : null}

      <form className="l3-form" onSubmit={loadContext}>
        <label>
          Context id
          <input disabled={isBusy} onChange={(event) => setContextId(event.target.value)} placeholder="ctx id" value={contextId} />
        </label>
        <button disabled={isBusy} type="submit">
          {status === "loading" ? "Loading context..." : "Load context"}
        </button>
      </form>

      <L3ErrorMessage error={error} />

      {detail ? (
        <div className="l3-result-panel space-result-panel">
          <div>
            <p className="eyebrow">{detail.context.context_type}</p>
            <h3>{detail.context.id}</h3>
            <span>{sourceLabel(detail.source)}</span>
          </div>
          <L3NavigationActions actions={[contextSourceNavigationAction(detail)]} onNavigate={onNavigate} />
          <dl className="stats-grid">
            {contextStatsRows(detail).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>

          <div className="space-card">
            <p className="eyebrow">Context Text</p>
            <p>{contextPreview(detail.context, 1200)}</p>
            <dl className="result-meta">
              <div><dt>Language</dt><dd>{detail.context.language ?? "unknown"}</dd></div>
              <div><dt>Created</dt><dd>{detail.context.created_at}</dd></div>
              <div><dt>Updated</dt><dd>{detail.context.updated_at}</dd></div>
              <div><dt>Position</dt><dd><code>{compactSpaceJson(detail.context.position) || "none"}</code></dd></div>
              <div><dt>Metadata</dt><dd><code>{compactSpaceJson(detail.context.metadata) || "none"}</code></dd></div>
            </dl>
          </div>

          {contextEmptyMessages(detail).map((message) => (
            <div className="placeholder-panel" key={message}>
              <strong>{message}</strong>
              <span>The context exists; this related read collection is empty.</span>
            </div>
          ))}

          <div className="space-section">
            <div className="detail-header"><div><p className="eyebrow">Occurrences</p><h3>Word occurrences</h3></div></div>
            {detail.occurrences.length === 0 ? <p className="empty-state">No occurrences.</p> : (
              <div className="space-list">
                {detail.occurrences.map((occurrence) => (
                  <div className="space-row" key={occurrence.id}>
                    <strong>{occurrenceSummary(occurrence)}</strong>
                    <span>word {occurrence.word_id} / confidence {occurrence.confidence ?? "none"}</span>
                    <L3NavigationActions actions={[occurrenceWordNavigationAction(occurrence, detail.source.wordbook_id)]} onNavigate={onNavigate} />
                    <code>{compactSpaceJson(occurrence.evidence) || "no evidence"}</code>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-section">
            <div className="detail-header"><div><p className="eyebrow">Links</p><h3>Context links</h3></div></div>
            {detail.links.length === 0 ? <p className="empty-state">No links.</p> : (
              <div className="space-list">
                {detail.links.map((link) => (
                  <div className="space-row" key={link.id}>
                    <strong>{linkSummary(link)}</strong>
                    <span>confidence {link.confidence ?? "none"} / created {link.created_at}</span>
                    <L3NavigationActions actions={[linkTargetNavigationAction(link)]} onNavigate={onNavigate} />
                    <code>{compactSpaceJson(link.provenance) || "no provenance"}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="placeholder-panel">
          <strong>Read-only context detail.</strong>
          <span>Enter a context id to load text, source metadata, occurrences, and links.</span>
        </div>
      )}
    </section>
  );
}
