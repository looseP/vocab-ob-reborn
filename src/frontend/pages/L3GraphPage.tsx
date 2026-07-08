export function L3GraphPage() {
  return (
    <section className="l3-page">
      <p className="eyebrow">Graph Placeholder</p>
      <h2>Graph is read-only and refreshes after proposal confirm.</h2>
      <p className="lede">
        Phase 4D/4E can add graph fetching and visualization. This shell intentionally avoids graph editing and graph library dependencies.
      </p>
      <div className="placeholder-panel">
        <strong>Read model only.</strong>
        <span>Graph loads should have no active/proposal/recommendation write side effects.</span>
      </div>
    </section>
  );
}
