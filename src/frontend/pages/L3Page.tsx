import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch } from "@/frontend/api/client";
import type { L3FrontendClient } from "@/l3/frontend/contract";
import { L3Bookshelf } from "@/frontend/components/l3/L3Bookshelf";
import { L3ReadingView } from "@/frontend/components/l3/L3ReadingView";
import { L3Shell, type L3ShellSection } from "@/frontend/components/L3Shell";
import { L3ContextPage } from "@/frontend/pages/L3ContextPage";
import { L3ErrorBookPage } from "@/frontend/pages/L3ErrorBookPage";
import { L3GraphPage } from "@/frontend/pages/L3GraphPage";
import { L3HomePage } from "@/frontend/pages/L3HomePage";
import { L3ImportPage } from "@/frontend/pages/L3ImportPage";
import { L3ManualEditorPage } from "@/frontend/pages/L3ManualEditorPage";
import { L3PapersPage } from "@/frontend/components/l3/L3PapersPage";
import { L3PracticePage } from "@/frontend/pages/L3PracticePage";
import { L3ProposalPage } from "@/frontend/pages/L3ProposalPage";
import { L3RecommendationPage } from "@/frontend/pages/L3RecommendationPage";
import { L3SessionPage } from "@/frontend/pages/L3SessionPage";
import { L3WordSpacePage } from "@/frontend/pages/L3WordSpacePage";
import { L3WritingPage } from "@/frontend/pages/L3WritingPage";
import { createBrowserL3Client } from "@/frontend/api/l3Client";
import { isWritingSection, WRITING_SECTION } from "@/frontend/viewModels/writingNavigation";
import {
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
  const navigate = useNavigate();
  const deepLinkContextId = searchParams.get("contextId");
  // B1（体验层）：默认落地 = 素材宇宙（设计基线 §2 IA-1）；深链（?sourceId=/
  // ?wordSlug=/?contextId=）仍会在挂载后把视图切到对应 section。
  const [section, setSection] = useState<L3ShellSection>("home");
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [graphHandoff, setGraphHandoff] = useState<L3GraphHandoff | null>(null);
  const [contextHandoff, setContextHandoff] = useState<L3ContextHandoff | null>(null);
  const [wordHandoff, setWordHandoff] = useState<L3WordHandoff | null>(null);
  const [sourceHandoff, setSourceHandoff] = useState<L3SourceHandoff | null>(null);
  const [focusContext, setFocusContext] = useState<{ contextId: string; nonce: number } | null>(null);
  const [activeReadStale, setActiveReadStale] = useState<L3ActiveReadStaleState | null>(null);
  const l3Client = useMemo<L3FrontendClient>(() => createBrowserL3Client(), []);

  // P0-2（2026-09-08 评估）：?contextId= 深链不再落工程检查器——先解析 context→source，
  // 落到对应来源的阅读视图并滚动+闪高亮该语境。这是 L2 Drill「查看原文」与复习卡
  // Tier 2 逐条语境深链的用户落点；解析失败（404 等）回退到工程检查器（contextHandoff）。
  useEffect(() => {
    if (!deepLinkContextId) return;
    let cancelled = false;
    apiFetch<{ context: { source_id: string } }>(`/l3/contexts/${encodeURIComponent(deepLinkContextId)}`, { timeoutMs: 10_000 })
      .then((detail) => {
        if (cancelled || !detail?.context?.source_id) return;
        const sourceId = detail.context.source_id;
        setFocusContext({ contextId: deepLinkContextId, nonce: Date.now() });
        setSection("source");
        setSourceHandoff((prev) => (prev?.sourceId === sourceId ? prev : { sourceId, nonce: Date.now() }));
      })
      .catch(() => {
        if (cancelled) return;
        setContextHandoff({ contextId: deepLinkContextId, nonce: Date.now() });
        setSection("context");
      });
    return () => { cancelled = true; };
  }, [deepLinkContextId]);

  // 书架/阅读视图深链（Task 12）：/l3?sourceId=xxx 直达来源阅读视图（复习卡 Tier 2、
  // 详情页语境区回流入口）；/l3?wordSlug=xxx 直达词空间。与 contextId 深链同款 handoff 模式。
  const deepLinkSourceId = searchParams.get("sourceId");
  const deepLinkWordSlug = searchParams.get("wordSlug");
  useEffect(() => {
    if (!deepLinkSourceId) return;
    setSourceHandoff({ sourceId: deepLinkSourceId, nonce: Date.now() });
    setSection("source");
  }, [deepLinkSourceId]);
  useEffect(() => {
    if (!deepLinkWordSlug) return;
    setWordHandoff({ slug: deepLinkWordSlug, nonce: Date.now() });
    setSection("word");
  }, [deepLinkWordSlug]);

  // 批次二（ADR-0034）：作答历史 modal 的「去题型空间打开此文」深链
  // /l3?venue=<题型>&file=<文件键> 直达试卷台的题型空间（L3PapersPage 消费参数
  // 自动打开目标文件；同 contextId/sourceId 的 handoff 模式）。
  // F-1（回看闭环）：?sheet=<id> 回看深链 / ?paper=<id> 卷深链——同模式落到试卷台。
  // 作文子空间 v1（W7）：section=writing 优先选择作文宿主（不被旧 sheet effect 抢回）。
  const deepLinkVenue = searchParams.get("venue");
  const deepLinkFile = searchParams.get("file");
  const deepLinkSheet = searchParams.get("sheet");
  const deepLinkPaper = searchParams.get("paper");
  const writingSectionPreferred = isWritingSection(searchParams);
  const writingTaskIdParam = searchParams.get("writingTaskId");

  useEffect(() => {
    if (writingSectionPreferred || writingTaskIdParam) setSection(WRITING_SECTION as L3ShellSection);
  }, [writingSectionPreferred, writingTaskIdParam]);

  // 纯 ?sheet=<id> 分流（只读）：先 GET 判 scope——file/paper 沿用 F-1 落试卷台；
  // writing 记录只读解析 taskId 并 replace 为作文规范 URL，**不调用 openSheet、不建纸**。
  useEffect(() => {
    if (!deepLinkSheet || writingSectionPreferred || deepLinkVenue || deepLinkPaper) return;
    let cancelled = false;
    apiFetch<{ sheet?: { scope?: string; writing_task_id?: string | null } }>(
      `/l3/sheets/${encodeURIComponent(deepLinkSheet)}`,
      { timeoutMs: 10_000 },
    )
      .then((detail) => {
        if (cancelled) return;
        const sheet = detail?.sheet;
        if (sheet?.scope === "writing" && sheet.writing_task_id) {
          navigate(
            `/l3?section=writing&writingTaskId=${encodeURIComponent(sheet.writing_task_id)}&sheet=${encodeURIComponent(deepLinkSheet)}`,
            { replace: true },
          );
          return;
        }
        setSection("papers");
      })
      .catch(() => {
        if (!cancelled) setSection("papers"); // 判读失败交回 F-1 原路（其自带 404 空态）
      });
    return () => { cancelled = true; };
  }, [deepLinkSheet, writingSectionPreferred, deepLinkVenue, deepLinkPaper, navigate]);

  useEffect(() => {
    if (!deepLinkVenue && !deepLinkSheet && !deepLinkPaper) return;
    if (writingSectionPreferred) return; // 作文宿主优先
    if (deepLinkSheet && !deepLinkVenue && !deepLinkPaper) return; // 分流 effect 处理
    setSection("papers");
  }, [deepLinkVenue, deepLinkSheet, deepLinkPaper, writingSectionPreferred]);

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
    // B1 素材宇宙：默认落地（设计基线 IA-1）；从这里可直接打开某篇来源的阅读视图
    // （带 contextId 时深链聚焦该圈记）。
    home: (
      <L3HomePage
        onOpenSource={(sourceId, contextId) => {
          setSourceHandoff({ sourceId, nonce: Date.now() });
          setFocusContext(contextId ? { contextId, nonce: Date.now() } : null);
          setSection("source");
        }}
        onNavigate={setSection}
      />
    ),
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
    // T11（ADR-0019）：练习 / 错题库 / 会话 —— 输出闭环的三个用户表面。
    // ADR-0030：试卷台（题型空间文件 + 我的试卷 + 粘贴建卷，V1 owner 入库面）。
    // F-1：题纸档案与回看深链（?sheet= 只读回看；?paper= 卷深链）。
    papers: (
      <L3PapersPage
        deepLinkVenue={deepLinkVenue}
        deepLinkFile={deepLinkFile}
        deepLinkSheet={deepLinkSheet}
        deepLinkPaper={deepLinkPaper}
      />
    ),
    // 作文子空间 v1（W7）：宿主页（section=writing 优先；搜索参数由页面自身消费，
    // 查看稿零创建、新稿只由显式 POST）。
    writing: <L3WritingPage />,
    practice: <L3PracticePage client={l3Client} onNavigate={navigateL3} />,
    errorBook: <L3ErrorBookPage client={l3Client} onNavigate={navigateL3} />,
    session: <L3SessionPage client={l3Client} onNavigate={navigateL3} />,
    // source section：书架为前门；选中来源后整屏切换为阅读视图（返回书架清除
    // handoff 回到书架）。原工程检查面板（L3SourceSpacePage）已删除。
    source: sourceHandoff ? (
      <L3ReadingView
        sourceId={sourceHandoff.sourceId}
        focusContextId={focusContext?.contextId}
        onBack={() => { setSourceHandoff(null); setFocusContext(null); }}
      />
    ) : (
      <L3Bookshelf onOpen={(sourceId) => { setSourceHandoff({ sourceId, nonce: Date.now() }); setFocusContext(null); }} />
    ),
  }[section];

  return (
    <L3Shell activeSection={section} onNavigate={setSection}>
      {page}
    </L3Shell>
  );
}
