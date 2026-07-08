import type { L3GraphStaleState } from "../state/l3CacheSignals";

interface L3GraphPageProps {
  staleState: L3GraphStaleState | null;
}

export function L3GraphPage({ staleState }: L3GraphPageProps) {
  return (
    <section className="l3-page">
      <p className="eyebrow">Graph Placeholder</p>
      <h2>Graph is read-only and refreshes after proposal confirm.</h2>
      <p className="lede">
        Phase 4D/4E can add graph fetching and visualization. This shell intentionally avoids graph editing and graph library dependencies.
      </p>
      {staleState ? (
        <div className="validation-panel invalid">
          <strong>Graph refresh required after confirm.</strong>
          <span>{staleState.reason}</span>
          <ul>
            {staleState.activeEntities.map((entity) => (
              <li key={`${entity.itemId}-${entity.activeEntityId}`}>
                {entity.activeEntityType}: {entity.activeEntityId}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="placeholder-panel">
        <strong>Read model only.</strong>
        <span>Graph loads should have no active/proposal/recommendation write side effects.</span>
      </div>
    </section>
  );
}
