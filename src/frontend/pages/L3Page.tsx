import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { L3FrontendClient } from "@/l3/frontend/contract";
import { L3Shell, type L3ShellSection } from "@/frontend/components/L3Shell";
import { L3ContextPage } from "@/frontend/pages/L3ContextPage";
import { L3GraphPage } from "@/frontend/pages/L3GraphPage";
import { L3HomePage } from "@/frontend/pages/L3HomePage";
import { L3ImportPage } from "@/frontend/pages/L3ImportPage";
import { L3ManualEditorPage } from "@/frontend/pages/L3ManualEditorPage";
import { L3ProposalPage } from "@/frontend/pages/L3ProposalPage";
import { L3RecommendationPage } from "@/frontend/pages/L3RecommendationPage";
import { L3SourceSpacePage } from "@/frontend/pages/L3SourceSpacePage";
import { L3WordSpacePage } from "@/frontend/pages/L3WordSpacePage";
import { createBrowserL3Client } from "@/frontend/api/l3Client";
import {
  PHASE_4C_CACHE_POLICY,
  markActiveReadStaleAfterManualCommand,
  markActiveReadStaleAfterProposalConfirm,
  type L3ActiveReadStaleState,
} from "@/frontend/state/l3CacheSignals";
import type {
  L3ContextHandoff,
  L3GraphHandoff,
  L3NavigationIntent,
  L3SourceHandoff,
  L3WordHandoff,
} from "@/frontend/viewModels/l3NavigationViewModel";

/**
 * The L3 sub-application under /l3. Section switching, cross-surface
 * navigation handoffs, and the active-read stale cache wiring are held in
 * local state here (the router only owns mounting the sub-app).
 * 独立成文件以便路由级代码分割（lazy import），避免 L3 全家桶进入首屏 bundle。
 */
export function L3Page() {
  const [searchParams] = useSearchParams();
  const deepLinkContextId = searchParams.get("contextId");
  const [section, setSection] = useState<L3ShellSection>("home");
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [graphHandoff, setGraphHandoff] = useState<L3GraphHandoff | null>(null);
  const [contextHandoff, setContextHandoff] = useState<L3ContextHandoff | null>(null);
  const [wordHandoff, setWordHandoff] = useState<L3WordHandoff | null>(null);
  const [sourceHandoff, setSourceHandoff] = useState<L3SourceHandoff | null>(null);
  const [activeReadStale, setActiveReadStale] = useState<L3ActiveReadStaleState | null>(null);
  const l3Client = useMemo<L3FrontendClient>(() => createBrowserL3Client(), []);

  // P3-9：支持 /l3?contextId=xxx 深链——挂载时与 URL 参数变化时自动定位到语境详情。
  // L2 产出步「查看原文」→ 直达对应语境，闭环 L3 溯源链路（L2ProductionTask 跳转）。
  useEffect(() => {
    if (!deepLinkContextId) return;
    setContextHandoff({ contextId: deepLinkContextId, nonce: Date.now() });
    setSection("context");
  }, [deepLinkContextId]);

  const openProposal = (proposalId: string) => {
    setSelectedProposalId(proposalId);
    setSection("proposals");
  };

  const openProposalQueue = () => {
    setSelectedProposalId(null);
    setSection("proposals");
  };

  const navigateL3 = (intent: L3NavigationIntent) => {
    if (intent.target === "graph") {
      setGraphHandoff({ ...intent.query, nonce: Date.now() });
      setSection("graph");
      return;
    }
    if (intent.target === "context") {
      setContextHandoff({ contextId: intent.contextId, nonce: Date.now() });
      setSection("context");
      return;
    }
    if (intent.target === "word") {
      setWordHandoff({ slug: intent.slug, ...(intent.wordbookId ? { wordbookId: intent.wordbookId } : {}), nonce: Date.now() });
      setSection("word");
      return;
    }
    if (intent.target === "source") {
      setSourceHandoff({ sourceId: intent.sourceId, nonce: Date.now() });
      setSection("source");
      return;
    }
    if (intent.target === "proposal") {
      intent.proposalId ? openProposal(intent.proposalId) : openProposalQueue();
      return;
    }
    if (intent.target === "recommendation") {
      setSection("recommendations");
    }
  };

  const page = {
    home: <L3HomePage cachePolicy={PHASE_4C_CACHE_POLICY} />,
    manual: <L3ManualEditorPage client={l3Client} onManualChanged={(reason) => setActiveReadStale(markActiveReadStaleAfterManualCommand(reason))} onNavigate={navigateL3} />,
    import: <L3ImportPage client={l3Client} onOpenProposal={openProposal} onOpenProposalQueue={openProposalQueue} />,
    proposals: (
      <L3ProposalPage
        client={l3Client}
        selectedProposalId={selectedProposalId}
        onSelectProposal={setSelectedProposalId}
        onConfirmed={(result) => setActiveReadStale(markActiveReadStaleAfterProposalConfirm(result))}
        onNavigate={navigateL3}
      />
    ),
    recommendations: <L3RecommendationPage client={l3Client} onNavigate={navigateL3} />,
    graph: <L3GraphPage client={l3Client} handoff={graphHandoff} staleState={activeReadStale} onGraphRefreshed={() => setActiveReadStale(null)} onNavigate={navigateL3} />,
    context: <L3ContextPage client={l3Client} handoff={contextHandoff} staleState={activeReadStale} onReadRefreshed={() => setActiveReadStale(null)} onNavigate={navigateL3} />,
    word: <L3WordSpacePage client={l3Client} handoff={wordHandoff} staleState={activeReadStale} onReadRefreshed={() => setActiveReadStale(null)} onNavigate={navigateL3} />,
    source: <L3SourceSpacePage client={l3Client} handoff={sourceHandoff} staleState={activeReadStale} onReadRefreshed={() => setActiveReadStale(null)} onNavigate={navigateL3} />,
  }[section];

  return (
    <L3Shell activeSection={section} onNavigate={setSection}>
      {page}
    </L3Shell>
  );
}
