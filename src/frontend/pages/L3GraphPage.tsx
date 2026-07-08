import { useState } from "react";
import type { L3GraphReadModel } from "@/domain";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import {
  isNormalizedL3Error,
  normalizeL3TransportError,
  type L3FrontendClient,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import type { L3GraphStaleState } from "../state/l3CacheSignals";
import {
  applyGraphReadUiResult,
  buildGraphQueryPayload,
  compactGraphJson,
  graphDepthOptions,
  graphEmptyMessage,
  graphStatsRows,
  summarizeGraphEdge,
  summarizeGraphNode,
} from "../viewModels/l3GraphViewModel";

interface L3GraphPageProps {
  client: L3FrontendClient;
  staleState: L3GraphStaleState | null;
  onGraphRefreshed(): void;
}

type WorkStatus = "idle" | "loading";

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

export function L3GraphPage({ client, staleState, onGraphRefreshed }: L3GraphPageProps) {
  const [wordbookId, setWordbookId] = useState("");
  const [slug, setSlug] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [depth, setDepth] = useState("1");
  const [limit, setLimit] = useState("100");
  const [cursor, setCursor] = useState("");
  const [graph, setGraph] = useState<L3GraphReadModel | null>(null);
  const [status, setStatus] = useState<WorkStatus>("idle");
  const [error, setError] = useState<NormalizedL3Error | null>(null);

  const isBusy = status !== "idle";
  const emptyMessage = graphEmptyMessage(graph);

  const loadGraph = async (requestedCursor?: string | null) => {
    setError(null);

    let payload;
    try {
      payload = buildGraphQueryPayload({
        wordbookId,
        slug,
        sourceId,
        depth,
        limit,
        cursor: requestedCursor ?? cursor,
      });
    } catch (caught) {
      setError(normalizeUnknownError(caught));
      return;
    }

    setStatus("loading");
    try {
      const response = await client.getGraph(payload);
      applyGraphReadUiResult(response);
      setGraph(response);
      setCursor(response.cursor ?? "");
      onGraphRefreshed();
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setStatus("idle");
    }
  };

  return (
    <section className="l3-page graph-page">
      <p className="eyebrow">Graph Read Surface</p>
      <h2>Read bounded L3 graph data without mutating active state.</h2>
      <p className="lede">
        Load graph nodes and edges through the shared L3 client. This view is read-only and does not create proposals, recommendations, or active L3 rows.
      </p>

      {staleState ? (
        <div className="validation-panel invalid">
          <strong>Graph may be stale after proposal confirmation.</strong>
          <span>{staleState.reason}</span>
          <ul>
            {staleState.activeEntities.map((entity) => (
              <li key={`${entity.itemId}-${entity.activeEntityId}`}>
                {entity.activeEntityType}: {entity.activeEntityId}
              </li>
            ))}
          </ul>
          <div className="action-row">
            <button disabled={isBusy} onClick={() => void loadGraph(null)} type="button">
              {status === "loading" ? "Refreshing..." : "Refresh graph"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="l3-form graph-query-form">
        <div className="form-row">
          <label>
            Wordbook id
            <input disabled={isBusy} onChange={(event) => setWordbookId(event.target.value)} placeholder="optional" value={wordbookId} />
          </label>
          <label>
            Slug
            <input disabled={isBusy} onChange={(event) => setSlug(event.target.value)} placeholder="optional" value={slug} />
          </label>
          <label>
            Source id
            <input disabled={isBusy} onChange={(event) => setSourceId(event.target.value)} placeholder="optional" value={sourceId} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Depth
            <select disabled={isBusy} onChange={(event) => setDepth(event.target.value)} value={depth}>
              {graphDepthOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
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
          <button disabled={isBusy} onClick={() => void loadGraph(null)} type="button">
            {status === "loading" ? "Loading graph..." : "Load graph"}
          </button>
          {graph?.nextCursor ? (
            <button disabled={isBusy} onClick={() => void loadGraph(graph.nextCursor)} type="button">
              Next page
            </button>
          ) : null}
        </div>
      </div>

      <L3ErrorMessage error={error} />

      {graph ? (
        <div className="l3-result-panel graph-result-panel">
          <div>
            <p className="eyebrow">Graph Stats</p>
            <h3>{graph.nodes.length} nodes / {graph.edges.length} edges</h3>
            <span>Graph read completed with no mutation or cache invalidation side effects.</span>
          </div>
          <dl className="stats-grid">
            {graphStatsRows(graph).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>

          {emptyMessage ? (
            <div className="placeholder-panel">
              <strong>{emptyMessage}</strong>
              <span>Try a different slug, source, wordbook, depth, limit, or cursor.</span>
            </div>
          ) : null}

          <div className="graph-section">
            <div className="detail-header">
              <div>
                <p className="eyebrow">Nodes</p>
                <h3>Graph nodes</h3>
              </div>
            </div>
            {graph.nodes.length === 0 ? (
              <p className="empty-state">No nodes for current filters.</p>
            ) : (
              <div className="graph-table">
                <div className="graph-table-row graph-table-head">
                  <span>Type</span>
                  <span>Label</span>
                  <span>ID</span>
                  <span>Ref</span>
                  <span>Metadata</span>
                </div>
                {graph.nodes.map((node) => (
                  <div className="graph-table-row" key={node.id}>
                    <span className="type-badge">{node.type}</span>
                    <strong>{node.label}</strong>
                    <code>{node.id}</code>
                    <code>{compactGraphJson(node.ref, 220)}</code>
                    <code>{compactGraphJson(node.metadata, 220) || "none"}</code>
                    <span className="contract-note">{summarizeGraphNode(node)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="graph-section">
            <div className="detail-header">
              <div>
                <p className="eyebrow">Edges</p>
                <h3>Graph edges</h3>
              </div>
            </div>
            {graph.edges.length === 0 ? (
              <p className="empty-state">No graph edges for current filters.</p>
            ) : (
              <div className="graph-table">
                <div className="graph-table-row graph-table-head">
                  <span>Type</span>
                  <span>Source</span>
                  <span>Target</span>
                  <span>Confidence</span>
                  <span>Evidence / provenance</span>
                </div>
                {graph.edges.map((edge) => (
                  <div className="graph-table-row" key={edge.id}>
                    <span className="type-badge">{edge.type}</span>
                    <code>{edge.sourceNodeId}</code>
                    <code>{edge.targetNodeId}</code>
                    <span>{edge.confidence ?? "none"}</span>
                    <code>{compactGraphJson(edge.evidence ?? edge.provenance, 260) || "none"}</code>
                    <span className="contract-note">{summarizeGraphEdge(edge)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="placeholder-panel">
          <strong>Read model only.</strong>
          <span>Use the controls above to load nodes and edges. Graph loads have no active/proposal/recommendation write side effects.</span>
        </div>
      )}
    </section>
  );
}
