import { useState, type FormEvent } from "react";
import type { L3WordSpace } from "@/domain";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import {
  isNormalizedL3Error,
  normalizeL3TransportError,
  type L3FrontendClient,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import type { L3ActiveReadStaleState } from "../state/l3CacheSignals";
import {
  applySpaceReadUiResult,
  buildWordSpaceQueryPayload,
  compactSpaceJson,
  contextPreview,
  linkSummary,
  occurrenceSummary,
  readStaleBannerText,
  shouldClearReadStaleAfterSpaceRead,
  sourceLabel,
  wordLabel,
  wordSpaceEmptyMessage,
  wordSpaceStatsRows,
} from "../viewModels/l3SpaceViewModel";

interface L3WordSpacePageProps {
  client: L3FrontendClient;
  staleState: L3ActiveReadStaleState | null;
  onReadRefreshed(): void;
}

type WorkStatus = "idle" | "loading";

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

export function L3WordSpacePage({ client, staleState, onReadRefreshed }: L3WordSpacePageProps) {
  const [slug, setSlug] = useState("");
  const [wordbookId, setWordbookId] = useState("");
  const [limit, setLimit] = useState("50");
  const [cursor, setCursor] = useState("");
  const [space, setSpace] = useState<L3WordSpace | null>(null);
  const [status, setStatus] = useState<WorkStatus>("idle");
  const [error, setError] = useState<NormalizedL3Error | null>(null);
  const isBusy = status !== "idle";
  const staleText = readStaleBannerText(staleState);
  const emptyMessage = wordSpaceEmptyMessage(space);

  const loadWordSpace = async (event?: FormEvent<HTMLFormElement>, requestedCursor?: string | null) => {
    event?.preventDefault();
    setError(null);

    let payload;
    try {
      payload = buildWordSpaceQueryPayload({ slug, wordbookId, limit, cursor: requestedCursor ?? cursor });
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      return;
    }

    setStatus("loading");
    try {
      const response = await client.getWordSpace(payload.slug, payload.params);
      const transition = applySpaceReadUiResult(response, response.contexts.length === 0 && response.occurrences.length === 0 && response.links.length === 0);
      setSpace(response);
      setSlug(response.word.slug);
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
      <p className="eyebrow">Word Space</p>
      <h2>Read active L3 space around a word slug.</h2>
      <p className="lede">Use slug plus an optional wordbook id to inspect contexts, occurrences, links, and source summaries. A 404 remains a not-found error, not an empty state.</p>

      {staleText ? (
        <div className="validation-panel invalid">
          <strong>L3 read data may be stale after proposal confirmation.</strong>
          <span>{staleText}</span>
          <div className="action-row">
            <button disabled={isBusy} onClick={() => void loadWordSpace(undefined, null)} type="button">
              {status === "loading" ? "Refreshing..." : "Refresh word space"}
            </button>
          </div>
        </div>
      ) : null}

      <form className="l3-form graph-query-form" onSubmit={loadWordSpace}>
        <div className="form-row">
          <label>
            Slug
            <input disabled={isBusy} onChange={(event) => setSlug(event.target.value)} placeholder="required" value={slug} />
          </label>
          <label>
            Wordbook id
            <input disabled={isBusy} onChange={(event) => setWordbookId(event.target.value)} placeholder="optional" value={wordbookId} />
          </label>
        </div>
        <div className="form-row">
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
          <button disabled={isBusy} type="submit">{status === "loading" ? "Loading word..." : "Load word space"}</button>
          {space?.nextCursor ? <button disabled={isBusy} onClick={() => void loadWordSpace(undefined, space.nextCursor)} type="button">Next page</button> : null}
        </div>
      </form>

      <L3ErrorMessage error={error} />

      {space ? (
        <div className="l3-result-panel space-result-panel">
          <div>
            <p className="eyebrow">Word</p>
            <h3>{wordLabel(space.word)}</h3>
            <span>{space.word.slug} / {space.word.id} / wordbook filter {wordbookId.trim() || "none"}</span>
          </div>
          <dl className="stats-grid">
            {wordSpaceStatsRows(space).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>

          {emptyMessage ? (
            <div className="placeholder-panel">
              <strong>{emptyMessage}</strong>
              <span>The word lookup succeeded; the active related read collection is empty.</span>
            </div>
          ) : null}

          <div className="space-section">
            <div className="detail-header"><div><p className="eyebrow">Contexts</p><h3>Related contexts</h3></div></div>
            {space.contexts.length === 0 ? <p className="empty-state">No related contexts.</p> : (
              <div className="space-list">
                {space.contexts.map((context) => (
                  <div className="space-row" key={context.id}>
                    <strong>{contextPreview(context)}</strong>
                    <span>{context.context_type} / source {context.source_id} / updated {context.updated_at}</span>
                    <code>{compactSpaceJson(context.metadata) || "no metadata"}</code>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-section">
            <div className="detail-header"><div><p className="eyebrow">Occurrences</p><h3>Occurrences</h3></div></div>
            {space.occurrences.length === 0 ? <p className="empty-state">No occurrences.</p> : (
              <div className="space-list">
                {space.occurrences.map((occurrence) => (
                  <div className="space-row" key={occurrence.id}>
                    <strong>{occurrenceSummary(occurrence)}</strong>
                    <span>context {occurrence.context_id} / confidence {occurrence.confidence ?? "none"}</span>
                    <code>{compactSpaceJson(occurrence.evidence) || "no evidence"}</code>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-section">
            <div className="detail-header"><div><p className="eyebrow">Sources</p><h3>Source summaries</h3></div></div>
            {space.sources.length === 0 ? <p className="empty-state">No sources.</p> : (
              <div className="space-list">
                {space.sources.map((source) => (
                  <div className="space-row" key={source.id}>
                    <strong>{sourceLabel(source)}</strong>
                    <span>{source.author ?? "unknown author"} / {source.url ?? "no url"}</span>
                    <code>{compactSpaceJson(source.metadata) || "no metadata"}</code>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-section">
            <div className="detail-header"><div><p className="eyebrow">Links</p><h3>Context links</h3></div></div>
            {space.links.length === 0 ? <p className="empty-state">No context links.</p> : (
              <div className="space-list">
                {space.links.map((link) => (
                  <div className="space-row" key={link.id}>
                    <strong>{linkSummary(link)}</strong>
                    <span>confidence {link.confidence ?? "none"} / created {link.created_at}</span>
                    <code>{compactSpaceJson(link.provenance) || "no provenance"}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="placeholder-panel">
          <strong>Read-only word space.</strong>
          <span>Enter a slug to load related contexts, occurrences, links, and sources through the L3 client.</span>
        </div>
      )}
    </section>
  );
}
