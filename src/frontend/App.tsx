import { useMemo, useState } from "react";
import { L3Shell, type L3ShellSection } from "./components/L3Shell";
import { L3GraphPage } from "./pages/L3GraphPage";
import { L3HomePage } from "./pages/L3HomePage";
import { L3ImportPage } from "./pages/L3ImportPage";
import { L3ProposalPage } from "./pages/L3ProposalPage";
import { L3RecommendationPage } from "./pages/L3RecommendationPage";
import { createBrowserL3Client } from "./api/l3Client";
import { PHASE_4C_CACHE_POLICY, markGraphStaleAfterProposalConfirm, type L3GraphStaleState } from "./state/l3CacheSignals";

export function App() {
  const [section, setSection] = useState<L3ShellSection>("home");
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [graphStale, setGraphStale] = useState<L3GraphStaleState | null>(null);
  const l3Client = useMemo(() => createBrowserL3Client(), []);

  const openProposal = (proposalId: string) => {
    setSelectedProposalId(proposalId);
    setSection("proposals");
  };

  const page = {
    home: <L3HomePage cachePolicy={PHASE_4C_CACHE_POLICY} />,
    import: <L3ImportPage client={l3Client} onOpenProposal={openProposal} />,
    proposals: (
      <L3ProposalPage
        client={l3Client}
        selectedProposalId={selectedProposalId}
        onSelectProposal={setSelectedProposalId}
        onConfirmed={(result) => setGraphStale(markGraphStaleAfterProposalConfirm(result))}
      />
    ),
    recommendations: <L3RecommendationPage />,
    graph: <L3GraphPage staleState={graphStale} />,
  }[section];

  return (
    <L3Shell activeSection={section} onNavigate={setSection}>
      {page}
    </L3Shell>
  );
}
