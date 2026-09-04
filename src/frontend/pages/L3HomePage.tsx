import type { L3CacheSignal } from "@/l3/frontend/contract";

interface L3HomePageProps {
  cachePolicy: L3CacheSignal;
}

export function L3HomePage({ cachePolicy }: L3HomePageProps) {
  return (
    <section className="l3-page">
      <p className="eyebrow">Phase 4B Shell</p>
      <h2>L3 frontend host is ready for phased UI work.</h2>
      <p className="lede">
        This shell only anchors future L3 surfaces. Import, proposal, recommendation, and graph workflows remain placeholders for Phase 4C/4D.
      </p>
      <div className="l3-status-grid">
        <div>
          <span>Host</span>
          <strong>Vite + React + TypeScript</strong>
        </div>
        <div>
          <span>Contract</span>
          <strong>src/l3/frontend/contract.ts</strong>
        </div>
        <div>
          <span>Cache reason</span>
          <strong>{cachePolicy.reason}</strong>
        </div>
      </div>
    </section>
  );
}
