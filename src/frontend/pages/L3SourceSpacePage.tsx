import { useEffect, useState, type FormEvent } from "react";
import type { L3SourceSpace } from "@/domain";
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
  buildSourceSpaceQueryPayload,
  compactSpaceJson,
  contextPreview,
  linkSummary,
  occurrenceSummary,
  readStaleBannerText,
  shouldClearReadStaleAfterSpaceRead,
  sourceLabel,
  sourceSpaceEmptyMessage,
  sourceSpaceStatsRows,
} from "../viewModels/l3SpaceViewModel";
import {
  contextNavigationAction,
  graphForSourceNavigationAction,
  linkTargetNavigationAction,
  type L3SourceHandoff,
  occurrenceContextNavigationAction,
  occurrenceWordNavigationAction,
  type L3NavigationIntent,
} from "../viewModels/l3NavigationViewModel";

interface L3SourceSpacePageProps {
  client: L3FrontendClient;
  handoff: L3SourceHandoff | null;
  staleState: L3ActiveReadStaleState | null;
  onReadRefreshed(): void;
  onNavigate(intent: L3NavigationIntent): void;
}

type WorkStatus = "idle" | "loading";

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

export function L3SourceSpacePage({ client, handoff, staleState, onReadRefreshed, onNavigate }: L3SourceSpacePageProps) {
  const [sourceId, setSourceId] = useState("");
  const [limit, setLimit] = useState("50");
  const [cursor, setCursor] = useState("");
  const [space, setSpace] = useState<L3SourceSpace | null>(null);
  const [status, setStatus] = useState<WorkStatus>("idle");
  const [error, setError] = useState<NormalizedL3Error | null>(null);
  const isBusy = status !== "idle";
  const staleText = readStaleBannerText(staleState);
  const emptyMessage = sourceSpaceEmptyMessage(space);

  useEffect(() => {
    if (!handoff) return;
    setSourceId(handoff.sourceId);
    setCursor("");
  }, [handoff?.nonce]);

  const loadSourceSpace = async (event?: FormEvent<HTMLFormElement>, requestedCursor?: string | null) => {
    event?.preventDefault();
    setError(null);

    let payload;
    try {
      payload = buildSourceSpaceQueryPayload({ sourceId, limit, cursor: requestedCursor ?? cursor });
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      return;
    }

    setStatus("loading");
    try {
      const response = await client.getSourceSpace(payload.sourceId, payload.params);
      const transition = applySpaceReadUiResult(response, response.contexts.length === 0);
      setSpace(response);
      setSourceId(response.source.id);
      setCursor(response.cursor ?? "");
      if (shouldClearReadStaleAfterSpaceRead(transition)) onReadRefreshed();
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  return (
    <section className="l3-page space-page">
      <p className="eyebrow">Source Space</p>
      <h2>Read active L3 space for one source.</h2>
      <p className="lede">Lookup a source by id and browse its active contexts, occurrences, and links without writing source, context, occurrence, or link rows.</p>

      {staleText ? (
        <div className="validation-panel invalid">
          <strong>L3 read data may be stale after proposal confirmation.</strong>
          <span>{staleText}</span>
          <div className="action-row">
            <button disabled={isBusy} onClick={() => void loadSourceSpace(undefined, null)} type="button">
              {status === "loading" ? "Refreshing..." : "Refresh source space"}
            </button>
          </div>
        </div>
      ) : null}

      <form className="l3-form graph-query-form" onSubmit={loadSourceSpace}>
        <div className="form-row">
          <label>
            Source id
            <input disabled={isBusy} onChange={(event) => setSourceId(event.target.value)} placeholder="required" value={sourceId} />
          </label>
          <label>
            Limit
            <input disabled={isBusy} inputMode="numeric" onChange={(event) => setLimit(event.target.value)} value={limit} />
          </label>
          <label>
            Cursor
            <input disabled={isBusy} onChange={(event) => setCursor(event.target.value)} placeholder="optional" value={cursor} />
          </label>
        </div>
        <div className="action-row">
          <button disabled={isBusy} type="submit">{status === "loading" ? "Loading source..." : "Load source space"}</button>
          {space?.nextCursor ? <button disabled={isBusy} onClick={() => void loadSourceSpace(undefined, space.nextCursor)} type="button">Next page</button> : null}
        </div>
      </form>

      <L3ErrorMessage error={error} />

      {space ? (
        <div className="l3-result-panel space-result-panel">
          <div>
            <p className="eyebrow">Source</p>
            <h3>{sourceLabel(space.source)}</h3>
            <span>{space.source.id} / wordbook {space.source.wordbook_id ?? "none"} / language {space.source.language ?? "unknown"}</span>
          </div>
          <L3NavigationActions actions={[graphForSourceNavigationAction(space)]} onNavigate={onNavigate} />
          <dl className="stats-grid">
            {sourceSpaceStatsRows(space).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          <dl className="result-meta">
            <div><dt>Author</dt><dd>{space.source.author ?? "unknown"}</dd></div>
            <div><dt>URL</dt><dd>{space.source.url ?? "none"}</dd></div>
            <div><dt>Created</dt><dd>{space.source.created_at}</dd></div>
            <div><dt>Updated</dt><dd>{space.source.updated_at}</dd></div>
            <div><dt>Metadata</dt><dd><code>{compactSpaceJson(space.source.metadata) || "none"}</code></dd></div>
          </dl>

          {emptyMessage ? (
            <div className="placeholder-panel">
              <strong>{emptyMessage}</strong>
              <span>The source lookup succeeded; it has no active contexts in this page of results.</span>
            </div>
          ) : null}

          <div className="space-section">
            <div className="detail-header"><div><p className="eyebrow">Contexts</p><h3>Source contexts</h3></div></div>
            {space.contexts.length === 0 ? <p className="empty-state">No contexts.</p> : (
              <div className="space-list">
                {space.contexts.map((context) => (
                  <div className="space-row" key={context.id}>
                    <strong>{contextPreview(context)}</strong>
                    <span>{context.context_type} / language {context.language ?? "unknown"} / updated {context.updated_at}</span>
                    <L3NavigationActions actions={[contextNavigationAction(context)]} onNavigate={onNavigate} />
                    <code>{compactSpaceJson(context.metadata) || "no metadata"}</code>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-section">
            <div className="detail-header"><div><p className="eyebrow">Occurrences</p><h3>Occurrences grouped by context id</h3></div></div>
            {space.occurrences.length === 0 ? <p className="empty-state">No occurrences.</p> : (
              <div className="space-list">
                {space.occurrences.map((occurrence) => (
                  <div className="space-row" key={occurrence.id}>
                    <strong>{occurrence.context_id}: {occurrenceSummary(occurrence)}</strong>
                    <span>word {occurrence.word_id} / confidence {occurrence.confidence ?? "none"}</span>
                    <L3NavigationActions actions={[
                      occurrenceContextNavigationAction(occurrence),
                      occurrenceWordNavigationAction(occurrence, space.source.wordbook_id),
                    ]} onNavigate={onNavigate} />
                    <code>{compactSpaceJson(occurrence.evidence) || "no evidence"}</code>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-section">
            <div className="detail-header"><div><p className="eyebrow">Links</p><h3>Related links</h3></div></div>
            {space.links.length === 0 ? <p className="empty-state">No links.</p> : (
              <div className="space-list">
                {space.links.map((link) => (
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
          <strong>Read-only source space.</strong>
          <span>Enter a source id to load source metadata, contexts, occurrences, and related links.</span>
        </div>
      )}
    </section>
  );
}
