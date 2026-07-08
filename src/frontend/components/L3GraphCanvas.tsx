import type { L3GraphReadModel } from "@/domain";
import {
  buildGraphCanvasModel,
  compactGraphJson,
  getGraphEdgeDisplay,
  getGraphNodeDisplay,
  summarizeSelectedGraphItem,
  type GraphCanvasSelection,
} from "../viewModels/l3GraphViewModel";

interface L3GraphCanvasProps {
  graph: L3GraphReadModel | null;
  selection: GraphCanvasSelection;
  onSelect(selection: GraphCanvasSelection): void;
}

export function L3GraphCanvas({ graph, selection, onSelect }: L3GraphCanvasProps) {
  const model = buildGraphCanvasModel(graph);
  const selectedNode = selection?.kind === "node" ? graph?.nodes.find((node) => node.id === selection.id) ?? null : null;
  const selectedEdge = selection?.kind === "edge" ? graph?.edges.find((edge) => edge.id === selection.id) ?? null : null;

  if (model.state === "empty") {
    return (
      <div className="graph-canvas-panel">
        <div className="placeholder-panel">
          <strong>{model.summary}</strong>
          <span>The visual canvas renders only nodes and edges returned by the graph read response.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-canvas-panel">
      <div className="detail-header">
        <div>
          <p className="eyebrow">Visual Graph</p>
          <h3>Read-only graph canvas</h3>
          <span>{model.summary}</span>
        </div>
        <div className="graph-legend" aria-label="Graph legend">
          {model.legend.map((item) => (
            <span key={item.type}>
              <i style={{ backgroundColor: item.color }} />
              {item.label} ({item.count})
            </span>
          ))}
        </div>
      </div>

      <div className="graph-canvas-scroll">
        <svg aria-label="L3 graph visualization" className="graph-canvas" role="img" viewBox={model.viewBox}>
          <defs>
            <marker id="graph-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
              <path d="M0,0 L8,4 L0,8 Z" fill="#64748b" />
            </marker>
          </defs>
          {model.edges.map((edge) => {
            const selected = selection?.kind === "edge" && selection.id === edge.id;
            return (
              <g key={edge.id}>
                <line
                  className={selected ? "graph-canvas-edge selected" : "graph-canvas-edge"}
                  markerEnd="url(#graph-arrow)"
                  onClick={() => onSelect({ kind: "edge", id: edge.id })}
                  stroke={edge.color}
                  strokeDasharray={edge.missingEndpoint ? "6 6" : undefined}
                  tabIndex={0}
                  x1={edge.source.x}
                  x2={edge.target.x}
                  y1={edge.source.y}
                  y2={edge.target.y}
                >
                  <title>{`${edge.type}: ${edge.sourceNodeId} -> ${edge.targetNodeId}`}</title>
                </line>
              </g>
            );
          })}
          {model.nodes.map((node) => {
            const selected = selection?.kind === "node" && selection.id === node.id;
            return (
              <g
                className={selected ? "graph-canvas-node selected" : "graph-canvas-node"}
                key={node.id}
                onClick={() => onSelect({ kind: "node", id: node.id })}
                tabIndex={0}
                transform={`translate(${node.x} ${node.y})`}
              >
                <circle fill={node.color} r={node.radius} />
                <text textAnchor="middle" y={node.radius + 17}>{node.compactLabel}</text>
                <title>{`${node.type}: ${node.label}`}</title>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="graph-selection-panel">
        <strong>{summarizeSelectedGraphItem(graph, selection)}</strong>
        {selectedNode ? (
          <dl className="result-meta">
            <div><dt>Node</dt><dd>{selectedNode.id}</dd></div>
            <div><dt>Type</dt><dd>{getGraphNodeDisplay(selectedNode).typeLabel}</dd></div>
            <div><dt>Label</dt><dd>{getGraphNodeDisplay(selectedNode).label}</dd></div>
            <div><dt>Ref</dt><dd><code>{compactGraphJson(selectedNode.ref, 260) || "none"}</code></dd></div>
            <div><dt>Metadata</dt><dd><code>{compactGraphJson(selectedNode.metadata, 260) || "none"}</code></dd></div>
          </dl>
        ) : null}
        {selectedEdge ? (
          <dl className="result-meta">
            <div><dt>Edge</dt><dd>{selectedEdge.id}</dd></div>
            <div><dt>Type</dt><dd>{getGraphEdgeDisplay(selectedEdge).label}</dd></div>
            <div><dt>Source</dt><dd>{selectedEdge.sourceNodeId}</dd></div>
            <div><dt>Target</dt><dd>{selectedEdge.targetNodeId}</dd></div>
            <div><dt>Confidence</dt><dd>{selectedEdge.confidence ?? "none"}</dd></div>
            <div><dt>Evidence</dt><dd><code>{compactGraphJson(selectedEdge.evidence ?? selectedEdge.provenance, 260) || "none"}</code></dd></div>
          </dl>
        ) : null}
      </div>
    </div>
  );
}
