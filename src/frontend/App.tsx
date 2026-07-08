import { useMemo, useState } from "react";
import { L3Shell, type L3ShellSection } from "./components/L3Shell";
import { L3GraphPage } from "./pages/L3GraphPage";
import { L3HomePage } from "./pages/L3HomePage";
import { L3ImportPage } from "./pages/L3ImportPage";
import { L3ProposalPage } from "./pages/L3ProposalPage";
import { L3RecommendationPage } from "./pages/L3RecommendationPage";
import { createBrowserL3Client } from "./api/l3Client";
import { PHASE_4B_CACHE_POLICY } from "./state/l3CacheSignals";

export function App() {
  const [section, setSection] = useState<L3ShellSection>("home");
  const l3Client = useMemo(() => createBrowserL3Client(), []);

  const page = {
    home: <L3HomePage cachePolicy={PHASE_4B_CACHE_POLICY} />,
    import: <L3ImportPage client={l3Client} />,
    proposals: <L3ProposalPage />,
    recommendations: <L3RecommendationPage />,
    graph: <L3GraphPage />,
  }[section];

  return (
    <L3Shell activeSection={section} onNavigate={setSection}>
      {page}
    </L3Shell>
  );
}
