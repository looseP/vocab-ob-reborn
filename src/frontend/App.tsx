import { useMemo, useState } from "react";
import { L3Shell, type L3ShellSection } from "./components/L3Shell";
import { L3ContextPage } from "./pages/L3ContextPage";
import { L3GraphPage } from "./pages/L3GraphPage";
import { L3HomePage } from "./pages/L3HomePage";
import { L3ImportPage } from "./pages/L3ImportPage";
import { L3ProposalPage } from "./pages/L3ProposalPage";
import { L3RecommendationPage } from "./pages/L3RecommendationPage";
import { L3SourceSpacePage } from "./pages/L3SourceSpacePage";
import { L3WordSpacePage } from "./pages/L3WordSpacePage";
import { createBrowserL3Client } from "./api/l3Client";
import {
  PHASE_4C_CACHE_POLICY,
  markActiveReadStaleAfterProposalConfirm,
  type L3ActiveReadStaleState,
} from "./state/l3CacheSignals";

export function App() {
  const [section, setSection] = useState<L3ShellSection>("home");
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [activeReadStale, setActiveReadStale] = useState<L3ActiveReadStaleState | null>(null);
  const l3Client = useMemo(() => createBrowserL3Client(), []);

  const openProposal = (proposalId: string) => {
    setSelectedProposalId(proposalId);
    setSection("proposals");
  };

  const openProposalQueue = () => {
    setSelectedProposalId(null);
    setSection("proposals");
  };

  const page = {
    home: <L3HomePage cachePolicy={PHASE_4C_CACHE_POLICY} />,
    import: <L3ImportPage client={l3Client} onOpenProposal={openProposal} onOpenProposalQueue={openProposalQueue} />,
    proposals: (
      <L3ProposalPage
        client={l3Client}
        selectedProposalId={selectedProposalId}
        onSelectProposal={setSelectedProposalId}
        onConfirmed={(result) => setActiveReadStale(markActiveReadStaleAfterProposalConfirm(result))}
      />
    ),
    recommendations: <L3RecommendationPage client={l3Client} onOpenProposal={openProposal} />,
    graph: <L3GraphPage client={l3Client} staleState={activeReadStale} onGraphRefreshed={() => setActiveReadStale(null)} />,
    context: <L3ContextPage client={l3Client} staleState={activeReadStale} onReadRefreshed={() => setActiveReadStale(null)} />,
    word: <L3WordSpacePage client={l3Client} staleState={activeReadStale} onReadRefreshed={() => setActiveReadStale(null)} />,
    source: <L3SourceSpacePage client={l3Client} staleState={activeReadStale} onReadRefreshed={() => setActiveReadStale(null)} />,
  }[section];

  return (
    <L3Shell activeSection={section} onNavigate={setSection}>
      {page}
    </L3Shell>
  );
}
