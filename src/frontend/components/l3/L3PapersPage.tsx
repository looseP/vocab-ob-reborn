import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { useToast } from "@/frontend/components/ui/Toast";
import { L3ExamPaper, type ExamPaper } from "@/frontend/components/l3/L3ExamPaper";
import { fetchSheet, fetchSheetArchive, type L3SheetArchiveItem } from "@/frontend/api/l3Client";
import { writingClient } from "@/frontend/api/writingClient";
import {
  WritingQuestionEntry,
  type WritingEntryState,
} from "@/frontend/components/writing/WritingQuestionEntry";
import type { WritingOrigin, WritingOriginQuestionType } from "@/frontend/viewModels/writingNavigation";
import type { WritingQuestionTaskSummary } from "@/domain";

/**
 * 试卷台（ADR-0030 V1 最小可用面）：
 *  - 题型空间：七题型 chips → 派生做题文件列表 → 文件题组详情；
 *  - 我的试卷：卷列表 → 卷面组装详情（缺失引用降级占位）；
 *  - 粘贴建卷：owner 直写表单（section × 题 × 选项/答案），提交后自动落能力域标签。
 * 做题表面：批次二起，题型空间的 source 型文件直接复用 L3ExamPaper（file venue
 * 题纸自动开/作答防抖/定格/历史徽标）；fileKey 型文件（翻译/作文）保留浏览视图。
 */

type QuestionType =
  | "cloze" | "reading_choice" | "new_question" | "sentence_translation"
  | "short_essay" | "long_essay" | "grammar_blank";

const QUESTION_TYPES: QuestionType[] = [
  "cloze", "reading_choice", "new_question", "sentence_translation",
  "short_essay", "long_essay", "grammar_blank",
];
const TYPE_LABELS: Record<QuestionType, string> = {
  cloze: "完型",
  reading_choice: "阅读选择",
  new_question: "新题型",
  sentence_translation: "句译",
  short_essay: "小作文",
  long_essay: "大作文",
  grammar_blank: "语法填空",
};
const SOURCELESS_TYPES: QuestionType[] = ["sentence_translation", "short_essay", "long_essay"];
/** 作文子空间入口（W7）：仅这两类题显示「在作文空间练习」。 */
const ESSAY_TYPES: QuestionType[] = ["short_essay", "long_essay"];
const CHOICE_TYPES: QuestionType[] = ["cloze", "reading_choice", "new_question", "grammar_blank"];
const OPTION_KEYS = ["A", "B", "C", "D"] as const;

/** ExamPaper.direction 为宽松 string——作文入口需严格方向枚举（未知值归「通用」）。 */
function toWritingDirection(value: string | null | undefined): "通用" | "考研" | "雅思" {
  return value === "考研" || value === "雅思" ? value : "通用";
}

/** 七大题型专题空间（按卷面顺序；points=考纲标准分，grammar_blank 英二不考）。 */
const VENUES: Array<{
  type: QuestionType;
  name: string;
  en: string;
  points: number;
  blurb: string;
}> = [
  { type: "cloze", name: "完型填空", en: "Use of English", points: 10, blurb: "上下文推断 · 词义辨析 · 逻辑连接，20 空" },
  { type: "reading_choice", name: "阅读理解", en: "Reading · Part A", points: 40, blurb: "细节 · 推断 · 主旨 · 态度，四篇文章 20 题" },
  { type: "new_question", name: "新题型", en: "Reading · Part B", points: 10, blurb: "小标题匹配 · 七选五 · 段落排序" },
  { type: "sentence_translation", name: "英译汉", en: "Translation", points: 15, blurb: "整段翻译：理解准确、表达通顺连贯" },
  { type: "short_essay", name: "小作文", en: "Writing · Part A", points: 10, blurb: "应用文（邮件 / 通知），约 100 词" },
  { type: "long_essay", name: "大作文", en: "Writing · Part B", points: 15, blurb: "图表 / 图画作文，约 150 词" },
  { type: "grammar_blank", name: "语法填空", en: "Grammar Cloze", points: 0, blurb: "英二不设此题；可在「粘贴建卷」自行扩充练习" },
];

interface PracticeFile {
  question_type: QuestionType;
  source_id: string | null;
  file_key: string | null;
  title: string;
  direction: "通用" | "考研" | "雅思" | null;
  question_count: number;
  latest_created_at: string;
}

interface QuestionRow {
  id: string;
  ordinal: number;
  stem: string;
  options: Array<{ key: string; text: string }>;
  answer: { choice?: string; choices?: string[]; text?: string; sample?: string; points?: string[] };
  explanation: string | null;
  evidence: Array<{ start: number; end: number; label: string }>;
}

interface PracticeFileDetail {
  question_type: QuestionType;
  source: { id: string; title: string } | null;
  source_content: string | null;
  file_key: string | null;
  questions: QuestionRow[];
}

/** 文件三级详情：source 型组装单节伪卷喂给做题表面（file venue）；fileKey 型保留浏览（含作文入口）。 */
type FilesTabDetail =
  | {
      kind: "sheet";
      paper: ExamPaper;
      sourceId: string;
      questionType: QuestionType;
      /** 作文入口方向（与文件一致；缺省「通用」）。 */
      direction: "通用" | "考研" | "雅思" | null;
      /** 返回原题恢复：按 ID 读面（draft 可编辑 / sealed 只读；不经 openSheet 另开新纸）。 */
      replaySheetId: string | null;
    }
  | {
      kind: "browse";
      title: string;
      questions: QuestionRow[];
      direction: "通用" | "考研" | "雅思" | null;
      /** 来源标识（作文入口 origin 用：fileKey 型无 source；source 型无 fileKey）。 */
      fileKey: string | null;
      sourceId: string | null;
      questionType: QuestionType;
    };

interface AssembledSection {
  key: string;
  title: string;
  questionType: QuestionType;
  sourceId: string | null;
  fileKey: string | null;
  questionIds: string[];
  missing: boolean;
  missing_reason?: string;
  source_title: string | null;
  questions: QuestionRow[];
}

interface PaperDetail {
  id: string;
  title: string;
  direction: "通用" | "考研" | "雅思" | null;
  status: string;
  created_at: string;
  sections: AssembledSection[];
}

interface PaperListItem {
  id: string;
  title: string;
  direction: "通用" | "考研" | "雅思" | null;
  status: string;
  section_count: number;
  question_count: number;
  created_at: string;
}

interface SourceOption { id: string; title: string }

interface DraftQuestion {
  stem: string;
  options: Record<string, string>;
  answer: string;
  answerText: string;
}
interface DraftSection {
  title: string;
  questionType: QuestionType;
  sourceId: string;
  fileKey: string;
  questions: DraftQuestion[];
}

const emptyQuestion = (): DraftQuestion => ({ stem: "", options: {}, answer: "", answerText: "" });
const emptySection = (questionType: QuestionType = "reading_choice"): DraftSection => ({
  title: "",
  questionType,
  sourceId: "",
  fileKey: "",
  questions: [emptyQuestion()],
});

function QuestionList({ questions, writingEntryFor, focusedQuestionId }: {
  questions: QuestionRow[];
  /** 作文入口（I3）：essay 题由宿主渲染共享组件（fileKey/source/整卷/回看同源）。 */
  writingEntryFor?: (question: QuestionRow) => ReactNode;
  /** 返回原题定位（?question= 深链）：高亮该题。 */
  focusedQuestionId?: string | null;
}) {
  if (questions.length === 0) return <p className="text-xs text-[var(--color-ink-soft)]">（无题）</p>;
  return (
    <ol className="space-y-2">
      {questions.map((q) => (
        <li
          key={q.id}
          data-question-id={q.id}
          data-focused={focusedQuestionId === q.id ? "true" : undefined}
          className={`rounded-lg border p-2.5 ${focusedQuestionId === q.id ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]" : "border-[var(--color-border)]"}`}
        >
          <p className="whitespace-pre-wrap text-sm">{q.stem}</p>
          {q.options.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {q.options.map((opt) => (
                <li key={opt.key} className="text-xs text-[var(--color-ink-soft)]">
                  <span className={opt.key === q.answer.choice ? "font-semibold text-[var(--color-accent)]" : ""}>
                    {opt.key}.
                  </span> {opt.text}
                </li>
              ))}
            </ul>
          )}
          {(q.answer.choice || q.answer.text || q.answer.sample) && (
            <p className="mt-1.5 text-xs">
              <span className="text-[var(--color-ink-soft)]">答案：</span>
              {q.answer.choice ?? q.answer.text ?? q.answer.sample}
            </p>
          )}
          {q.explanation && <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--color-ink-soft)]">解析：{q.explanation}</p>}
          {writingEntryFor?.(q)}
        </li>
      ))}
    </ol>
  );
}

export function L3PapersPage({ deepLinkVenue, deepLinkFile, deepLinkSheet, deepLinkPaper, deepLinkQuestion, deepLinkResumeSheet }: {
  /** 批次二深链：?venue=<题型>&file=<文件键> 直达题型空间并自动打开目标文件。 */
  deepLinkVenue?: string | null;
  deepLinkFile?: string | null;
  /** F-1：?sheet=<id> 回看深链——只读指定题纸（不调 openSheet、不新建草稿）。 */
  deepLinkSheet?: string | null;
  /** F-1：?paper=<id> 卷深链（回看重做的常规入口）。 */
  deepLinkPaper?: string | null;
  /** I3：?question=<id> 返回原题定位（滚动 + 高亮；全程零创建）。 */
  deepLinkQuestion?: string | null;
  /** I3：?resumeSheet=<id> 返回原题恢复（draft 可编辑 / sealed 只读；一次性消费）。 */
  deepLinkResumeSheet?: string | null;
} = {}) {
  const { addToast } = useToast();
  const hasFilesDeepLink = Boolean(deepLinkVenue && QUESTION_TYPES.includes(deepLinkVenue as QuestionType));
  const [tab, setTab] = useState<"files" | "papers" | "archive" | "build">(
    deepLinkSheet ? "archive" : deepLinkPaper ? "papers" : hasFilesDeepLink ? "files" : "papers",
  );

  // F-1：深链参数到达即切到对应页签（回看退出后仍留在档案上下文；venue 深链同受益）。
  useEffect(() => {
    if (deepLinkSheet) setTab("archive");
    else if (deepLinkPaper) setTab("papers");
    else if (hasFilesDeepLink) setTab("files");
  }, [deepLinkSheet, deepLinkPaper, hasFilesDeepLink]);

  // F-1：回看模式整体接管——按 sheetId 装配卷面（读写全走只读路径；退出/重做由内层回调导航）。
  if (deepLinkSheet) {
    return <SheetReplayView sheetId={deepLinkSheet} />;
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="eyebrow">试卷工作台</p>
        <h2 className="text-lg font-semibold">试卷台</h2>
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {([["files", "题型空间"], ["papers", "我的试卷"], ["archive", "题纸档案"], ["build", "粘贴建卷"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`rounded-full px-3 py-1 text-xs ${tab === id ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]" : "border border-[var(--color-border)] text-[var(--color-ink-soft)]"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "files" && (
        <FilesTab deepLink={hasFilesDeepLink ? { venue: deepLinkVenue as QuestionType, file: deepLinkFile ?? null, question: deepLinkQuestion ?? null, resumeSheet: deepLinkResumeSheet ?? null } : null} />
      )}
      {tab === "papers" && (
        <PapersTab
          onToast={addToast}
          deepLink={deepLinkPaper ?? null}
          deepLinkQuestion={deepLinkQuestion ?? null}
          deepLinkResumeSheet={deepLinkResumeSheet ?? null}
        />
      )}
      {tab === "archive" && <ArchiveTab onToast={addToast} />}
      {tab === "build" && <BuildTab onBuilt={() => setTab("papers")} onToast={addToast} />}
    </div>
  );
}

/** file venue 伪卷组装（题型空间文件 → 做题表面；F-1 回看复用同一形态）。 */
function buildFileVenuePaper(
  detail: PracticeFileDetail,
  sourceId: string,
  questionType: QuestionType,
  title: string,
): ExamPaper {
  return {
    id: `file:${sourceId}:${questionType}`,
    title,
    direction: null,
    metadata: {},
    sections: [{
      key: "file",
      title,
      questionType,
      sourceId,
      fileKey: null,
      questionIds: detail.questions.map((q) => q.id),
      missing: false,
      source_title: detail.source?.title ?? null,
      source_content: detail.source_content,
      questions: detail.questions,
    }],
  };
}

function FilesTab({ deepLink }: {
  deepLink?: { venue: QuestionType; file: string | null; question?: string | null; resumeSheet?: string | null } | null;
} = {}) {
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [files, setFiles] = useState<PracticeFile[] | null>(null);
  const [venue, setVenue] = useState<QuestionType | null>(deepLink?.venue ?? null);
  const [detail, setDetail] = useState<FilesTabDetail | null>(null);
  const [pendingFileKey, setPendingFileKey] = useState<string | null>(deepLink?.file ?? null);
  /** F-1「再做一次」：换 key 重挂载做题面（openSheet 幂等语义决定复用/新建）。 */
  const [retakeNonce, setRetakeNonce] = useState(0);
  /** I3：作文入口批量摘要（fileKey 浏览视图；题组级一次读取，按钮不自取整套）。 */
  const [summaries, setSummaries] = useState<{
    status: WritingEntryState;
    byQuestion: Map<string, WritingQuestionTaskSummary[]>;
  }>({ status: "loading", byQuestion: new Map() });
  const [summariesNonce, setSummariesNonce] = useState(0);
  /** 返回原题（?question=）：定位并高亮目标题（零创建）。 */
  const [focusedQuestionId, setFocusedQuestionId] = useState<string | null>(deepLink?.question ?? null);
  /** 返回原题恢复（I3）：一次性——打开文件时校验并按 ID 读面；不匹配/不可达 → 提示并回到列表。 */
  const pendingResumeSheetRef = useRef<string | null>(deepLink?.resumeSheet ?? null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: PracticeFile[] }>("/l3/practice-files?limit=100")
      .then((page) => { if (!cancelled) setFiles(page.items); })
      .catch(() => { if (!cancelled) { addToast("error", "专题空间加载失败"); setFiles([]); } });
    return () => { cancelled = true; };
  }, [addToast]);

  const openFile = async (file: PracticeFile) => {
    const params = new URLSearchParams({ questionType: file.question_type });
    if (file.source_id) params.set("sourceId", file.source_id);
    if (file.file_key) params.set("fileKey", file.file_key);
    try {
      const body = await apiFetch<PracticeFileDetail>(`/l3/practice-files/detail?${params}`);
      // source 型文件（阅读/完形/新题型/语法填空）：组装单节伪卷，接入做题表面——
      // 题纸自动开（file:<sourceId>:<questionType>）、作答防抖、定格三档、历史徽标
      // 全复用 L3ExamPaper。fileKey 型（翻译/作文无 source）暂不具备开纸条件
      // （sheetOpenInputSchema 要求 sourceId），保留浏览视图。
      if (body.source && file.source_id) {
        // I3：返回原题恢复——按 resumeSheet 的 ID 读面（draft 可编辑 / sealed 只读）；
        // 与来源不匹配或不可达（清理/删除）→ 明确提示并停留文件列表，不偷偷另开新纸。
        let replaySheetId: string | null = null;
        const resumeId = pendingResumeSheetRef.current;
        if (resumeId) {
          pendingResumeSheetRef.current = null;
          try {
            const { sheet: row } = await fetchSheet(resumeId);
            const compatible = row.scope === "file"
              && row.source_id === file.source_id
              && row.question_type === file.question_type
              && row.status !== "discarded";
            if (!compatible) {
              addToast("error", "原题纸不可用或与来源不匹配，已回到文件列表。");
              return;
            }
            replaySheetId = resumeId;
          } catch {
            addToast("error", "原题纸不可用（可能已清理或删除），已回到文件列表。");
            return;
          }
        }
        setDetail({
          kind: "sheet",
          sourceId: file.source_id,
          questionType: file.question_type,
          direction: file.direction,
          replaySheetId,
          paper: buildFileVenuePaper(body, file.source_id, file.question_type, file.title),
        });
      } else {
        setDetail({
          kind: "browse",
          title: file.title,
          questions: body.questions,
          direction: file.direction,
          fileKey: file.file_key,
          sourceId: file.source_id,
          questionType: file.question_type,
        });
      }
    } catch {
      addToast("error", "文件题组加载失败");
    }
  };

  // 批次二深链：文件列表就绪后自动打开目标文件（?venue=<题型>&file=<source_id|file_key>）。
  // 🔴 同 PapersTab：StrictMode 下 files 双落地会双触发本效应——一次性消费，防 resumeSheet
  // 被二次消费后退化为 openSheet 另开新纸。
  const deepLinkConsumedRef = useRef(false);
  const openFileRef = useRef<typeof openFile | null>(null);
  useEffect(() => { openFileRef.current = openFile; });
  useEffect(() => {
    if (!pendingFileKey || !venue || !files) return;
    if (deepLinkConsumedRef.current) return;
    deepLinkConsumedRef.current = true;
    const target = files.find((file) => file.question_type === venue
      && (file.source_id === pendingFileKey || file.file_key === pendingFileKey));
    setPendingFileKey(null);
    if (target) void openFileRef.current?.(target);
  }, [pendingFileKey, venue, files]);

  // I3：fileKey 作文题组——题组级**一次**批量摘要读取（重试与「返回原题」重进均重新读取，
  // 不沿用进入前的「尚未开始」）；按钮自身零请求。
  useEffect(() => {
    if (!detail || detail.kind !== "browse" || !ESSAY_TYPES.includes(detail.questionType)) return;
    const questionIds = detail.questions.map((q) => q.id);
    if (questionIds.length === 0) {
      setSummaries({ status: "ready", byQuestion: new Map() });
      return;
    }
    let cancelled = false;
    setSummaries((prev) => ({ status: "loading", byQuestion: prev.byQuestion }));
    writingClient
      .questionSummaries(questionIds, { kind: "whole", direction: detail.direction ?? "通用" })
      .then((page) => {
        if (cancelled) return;
        setSummaries({
          status: "ready",
          byQuestion: new Map(page.items.map((item) => [item.questionId, item.tasks])),
        });
      })
      .catch(() => {
        if (!cancelled) setSummaries({ status: "error", byQuestion: new Map() });
      });
    return () => { cancelled = true; };
  }, [detail, summariesNonce]);

  // 返回原题：题组渲染后滚动定位（无滚动容器/jsdom 时静默）。
  useEffect(() => {
    if (!focusedQuestionId || !detail || detail.kind !== "browse") return;
    const el = document.querySelector(`[data-question-id="${focusedQuestionId}"]`);
    el?.scrollIntoView?.({ block: "start" });
  }, [focusedQuestionId, detail]);

  // 三级：文件详情——source 型走做题表面（file venue 题纸）；fileKey 型保留浏览
  if (detail && venue) {
    if (detail.kind === "sheet") {
      return (
        <L3ExamPaper
          key={`${detail.paper.id}:${retakeNonce}`}
          paper={detail.paper}
          fileVenue={{ sourceId: detail.sourceId, questionType: detail.questionType }}
          {...(detail.replaySheetId ? { replaySheetId: detail.replaySheetId } : {})}
          focusQuestionId={focusedQuestionId}
          writingEntry={{ direction: detail.direction ?? "通用", onNavigate: (url) => navigate(url) }}
          onBack={() => setDetail(null)}
          onRetake={() => setRetakeNonce((n) => n + 1)}
        />
      );
    }
    // I3：essay 题（小/大作文）渲染共享作文入口；origin 依来源身份构造（fileKey|sourceId）。
    const essayType = ESSAY_TYPES.includes(detail.questionType)
      ? (detail.questionType as WritingOriginQuestionType)
      : null;
    let writingEntryFor: ((question: QuestionRow) => ReactNode) | undefined;
    if (essayType) {
      const questionType = essayType;
      writingEntryFor = (question) => {
        const origin: WritingOrigin = {
          v: 1,
          kind: "file",
          questionId: question.id,
          questionType,
          fileKey: detail.fileKey,
          sourceId: detail.sourceId,
          sheetId: null, // fileKey 型无原卷题纸；进入后按需回看的是专项稿
        };
        return (
          <WritingQuestionEntry
            questionId={question.id}
            kind="whole"
            direction={detail.direction ?? "通用"}
            origin={origin}
            tasks={summaries.byQuestion.get(question.id) ?? []}
            state={summaries.status}
            onRetry={() => setSummariesNonce((n) => n + 1)}
            onNavigate={(url) => navigate(url)}
          />
        );
      };
    }
    return (
      <div className="space-y-2">
        <button type="button" onClick={() => setDetail(null)} className="text-xs text-[var(--color-accent)]">← 返回{VENUES.find((v) => v.type === venue)?.name}空间</button>
        <h3 className="text-base font-semibold">{detail.title}</h3>
        <QuestionList
          questions={detail.questions}
          focusedQuestionId={focusedQuestionId}
          writingEntryFor={writingEntryFor}
        />
      </div>
    );
  }

  // 二级：单专题空间的文件列表
  if (venue) {
    const meta = VENUES.find((v) => v.type === venue)!;
    const venueFiles = (files ?? [])
      .filter((f) => f.question_type === venue)
      .sort((a, b) => {
        // 阅读按 Text N 稳定排序；其余按标题
        const na = a.title.match(/Text\s*(\d+)/i);
        const nb = b.title.match(/Text\s*(\d+)/i);
        if (na && nb) return Number(na[1]) - Number(nb[1]);
        return a.title.localeCompare(b.title, "zh");
      });
    const questionTotal = venueFiles.reduce((sum, f) => sum + f.question_count, 0);
    return (
      <div className="space-y-3">
        <button type="button" onClick={() => setVenue(null)} className="text-xs text-[var(--color-accent)]">← 返回专题全景</button>
        <div className="flex items-center gap-3 rounded-xl bg-gradient-to-br from-[var(--color-accent-soft,var(--color-surface))] to-transparent p-4 ring-1 ring-[var(--color-border)]">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-accent)] text-base font-bold text-[var(--color-accent-contrast,var(--color-surface))]">
            {meta.name.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold">{meta.name} <span className="ml-1 text-xs font-normal text-[var(--color-ink-soft)]">{meta.en}</span></h3>
            <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{meta.blurb}</p>
          </div>
          <div className="ml-auto shrink-0 text-right text-xs text-[var(--color-ink-soft)]">
            <div className="text-lg font-bold text-[var(--color-ink)]">{venueFiles.length}</div>
            <div>文件 · {questionTotal} 题{meta.points > 0 ? ` · ${meta.points} 分` : ""}</div>
          </div>
        </div>
        {venueFiles.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-ink-soft)]">
            这个空间还没有文件。上传一份真题，或让 agent 帮你把试卷拆成文件录进来，考场就会在这里长出来。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {venueFiles.map((file) => (
              <li key={`${file.question_type}-${file.source_id ?? file.file_key}`}>
                <button type="button" onClick={() => void openFile(file)}
                  className="group flex w-full items-center justify-between rounded-lg border border-[var(--color-border)] px-3 py-2.5 text-left text-sm transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft,var(--color-surface))]">
                  <span className="min-w-0 truncate">{file.title}</span>
                  <span className="ml-3 shrink-0 text-xs text-[var(--color-ink-soft)]">{file.question_count} 题 <span className="text-[var(--color-accent)] opacity-0 transition-opacity group-hover:opacity-100">开练 →</span></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // 一级：七大专题空间全景
  const filesByType = new Map<QuestionType, PracticeFile[]>();
  for (const file of files ?? []) {
    const list = filesByType.get(file.question_type) ?? [];
    list.push(file);
    filesByType.set(file.question_type, list);
  }
  const totalQuestions = (files ?? []).reduce((sum, f) => sum + f.question_count, 0);
  const filledVenues = VENUES.filter((v) => (filesByType.get(v.type)?.length ?? 0) > 0).length;

  return (
    <div className="space-y-3">
      {files === null ? (
        <p className="text-sm text-[var(--color-ink-soft)]">加载中…</p>
      ) : (
        <>
          <p className="text-xs text-[var(--color-ink-soft)]">
            七个题型专题 · 已收录 <strong className="text-[var(--color-ink)]">{filledVenues}</strong> 个空间、{files.length} 个做题文件、{totalQuestions} 道真题。点击空间进入该题型练习。
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {VENUES.map((meta) => {
              const venueFiles = filesByType.get(meta.type) ?? [];
              const questionTotal = venueFiles.reduce((sum, f) => sum + f.question_count, 0);
              const empty = venueFiles.length === 0;
              return (
                <button key={meta.type} type="button" onClick={() => setVenue(meta.type)}
                  className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md ${empty ? "border-dashed border-[var(--color-border)] opacity-70 hover:opacity-100" : "border-[var(--color-border)] hover:border-[var(--color-accent)]"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="flex items-center gap-2 text-sm font-bold">
                        {meta.name}
                        {!empty && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">已收录</span>}
                      </h4>
                      <p className="mt-0.5 text-[11px] text-[var(--color-ink-soft)]">{meta.en}</p>
                    </div>
                    {meta.points > 0 && (
                      <span className="shrink-0 rounded-full bg-[var(--color-accent-soft,var(--color-surface))] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-accent)]">{meta.points} 分</span>
                    )}
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-[var(--color-ink-soft)]">{meta.blurb}</p>
                  <div className="mt-3 flex items-center justify-between text-xs">
                    {empty ? (
                      <span className="text-[var(--color-ink-soft)]">暂无真题文件</span>
                    ) : (
                      <span className="text-[var(--color-ink-soft)]">{venueFiles.length} 个文件 · <strong className="text-[var(--color-ink)]">{questionTotal}</strong> 题</span>
                    )}
                    <span className="text-[var(--color-accent)] opacity-0 transition-opacity group-hover:opacity-100">进入 →</span>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function PapersTab({ onToast, deepLink, deepLinkQuestion, deepLinkResumeSheet }: {
  onToast: (kind: "success" | "error", msg: string) => void;
  /** F-1：?paper=<id> 深链——列表就绪后自动开卷（回看重做的常规入口落点）。 */
  deepLink?: string | null;
  /** I3：?question= 返回原题定位（滚动 + 高亮；零创建）。 */
  deepLinkQuestion?: string | null;
  /** I3：?resumeSheet= 返回原题恢复（按 ID 读面；一次性消费）。 */
  deepLinkResumeSheet?: string | null;
}) {
  const navigate = useNavigate();
  const [papers, setPapers] = useState<PaperListItem[] | null>(null);
  const [detail, setDetail] = useState<ExamPaper | null>(null);
  const [retakeNonce, setRetakeNonce] = useState(0);
  const [resumeSheetId, setResumeSheetId] = useState<string | null>(null);
  const pendingResumeSheetRef = useRef<string | null>(deepLinkResumeSheet ?? null);

  const load = useCallback(async () => {
    try {
      const page = await apiFetch<{ items: PaperListItem[] }>("/l3/papers?limit=100");
      setPapers(page.items);
    } catch {
      onToast("error", "试卷列表加载失败");
      setPapers([]);
    }
  }, [onToast]);
  useEffect(() => { void load(); }, [load]);

  const openPaper = async (id: string) => {
    try {
      const next = await apiFetch<ExamPaper>(`/l3/papers/${id}`);
      // I3：返回原题恢复——resumeSheet 校验后按 ID 读面（draft 可编辑 / sealed 只读）；
      // 不匹配或不可达 → 明确提示并停留试卷列表（不另开新卷、不显示可编辑假象）。
      let replaySheetId: string | null = null;
      const resumeId = pendingResumeSheetRef.current;
      if (resumeId) {
        pendingResumeSheetRef.current = null;
        try {
          const { sheet: row } = await fetchSheet(resumeId);
          const compatible = row.scope === "paper" && row.paper_id === id && row.status !== "discarded";
          if (!compatible) {
            onToast("error", "原题纸不可用或与试卷不匹配，已回到试卷列表。");
            return;
          }
          replaySheetId = resumeId;
        } catch {
          onToast("error", "原题纸不可用（可能已清理或删除），已回到试卷列表。");
          return;
        }
      }
      setResumeSheetId(replaySheetId);
      setDetail(next);
    } catch {
      onToast("error", "试卷详情加载失败");
    }
  };

  // F-1 深链：列表就绪后自动开卷（ref 持有最新闭包，效果只盯 deepLink/papers 变化）。
  // 🔴 StrictMode（dev）下 load() 双跑会让 papers 两次落地 → 本效应双触发；必须一次性消费，
  // 否则第二次（resumeSheet 已被消费）会退化成 openSheet——sealed 恢复场景将另建新卷（C 批实证）。
  const deepLinkOpenedRef = useRef<string | null>(null);
  const openPaperRef = useRef<typeof openPaper | null>(null);
  useEffect(() => { openPaperRef.current = openPaper; });
  useEffect(() => {
    if (!deepLink || !papers) return;
    if (deepLinkOpenedRef.current === deepLink) return;
    deepLinkOpenedRef.current = deepLink;
    void openPaperRef.current?.(deepLink);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink, papers]);

  if (detail) {
    return (
      <L3ExamPaper
        key={`${detail.id}:${retakeNonce}`}
        paper={detail}
        {...(resumeSheetId ? { replaySheetId: resumeSheetId } : {})}
        focusQuestionId={deepLinkQuestion ?? null}
        writingEntry={{ direction: toWritingDirection(detail.direction), onNavigate: (url) => navigate(url) }}
        onBack={() => setDetail(null)}
        onRetake={() => setRetakeNonce((n) => n + 1)}
      />
    );
  }

  return papers === null ? (
    <p className="text-sm text-[var(--color-ink-soft)]">加载中…</p>
  ) : papers.length === 0 ? (
    <p className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-ink-soft)]">还没有试卷，用「粘贴建卷」录入第一份。</p>
  ) : (
    <ul className="space-y-1.5">
      {papers.map((paper) => (
        <li key={paper.id}>
          <button type="button" onClick={() => void openPaper(paper.id)}
            className="group flex w-full items-center justify-between rounded-lg border border-[var(--color-border)] px-3 py-2.5 text-left text-sm transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft,var(--color-surface))]">
            <span className="font-medium">{paper.title}</span>
            <span className="text-xs text-[var(--color-ink-soft)]">{paper.section_count} 节 · {paper.question_count} 题 · <span className="text-[var(--color-accent)] opacity-0 transition-opacity group-hover:opacity-100">开卷 →</span></span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function BuildTab({ onBuilt, onToast }: { onBuilt: () => void; onToast: (kind: "success" | "error", msg: string) => void }) {
  const [title, setTitle] = useState("");
  const [direction, setDirection] = useState<"" | "通用" | "考研" | "雅思">("考研");
  const [sections, setSections] = useState<DraftSection[]>([emptySection()]);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<{ items: SourceOption[] }>("/l3/sources?limit=100&sort=recent")
      .then((page) => setSources(page.items))
      .catch(() => setSources([]));
  }, []);

  const patchSection = (index: number, patch: Partial<DraftSection>) =>
    setSections((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const patchQuestion = (si: number, qi: number, patch: Partial<DraftQuestion>) =>
    setSections((prev) => prev.map((s, i) => i === si
      ? { ...s, questions: s.questions.map((q, j) => (j === qi ? { ...q, ...patch } : q)) }
      : s));

  const submit = async () => {
    if (!title.trim()) { onToast("error", "请填写试卷标题"); return; }
    for (const [si, section] of sections.entries()) {
      if (!section.title.trim()) { onToast("error", `第 ${si + 1} 节缺标题`); return; }
      if (!SOURCELESS_TYPES.includes(section.questionType) && !section.sourceId) {
        onToast("error", `「${section.title}」需要选择阅读材料`);
        return;
      }
      if (section.questions.some((q) => !q.stem.trim())) {
        onToast("error", `「${section.title}」存在空题干`);
        return;
      }
    }
    const payload = {
      title: title.trim(),
      direction: direction || null,
      sections: sections.map((section, si) => {
        const choice = CHOICE_TYPES.includes(section.questionType);
        return {
          title: section.title.trim(),
          questionType: section.questionType,
          sourceId: choice || !SOURCELESS_TYPES.includes(section.questionType) ? section.sourceId : null,
          fileKey: SOURCELESS_TYPES.includes(section.questionType)
            ? (section.fileKey.trim() || `${title.trim().slice(0, 20)}-${section.questionType}-${si + 1}`)
            : null,
          questions: section.questions.map((q) => ({
            stem: q.stem.trim(),
            ...(choice ? {
              options: OPTION_KEYS.map((key) => ({ key, text: q.options[key] ?? "" })).filter((o) => o.text.trim()),
              answer: q.answer ? { choice: q.answer } : {},
            } : { answer: q.answerText.trim() ? { text: q.answerText.trim() } : {} }),
          })),
        };
      }),
    };
    setSaving(true);
    try {
      await apiFetch("/l3/papers", { method: "POST", body: JSON.stringify(payload) });
      onToast("success", `已建卷：${title.trim()}（能力域标签已自动落好）`);
      onBuilt();
    } catch (err) {
      onToast("error", err instanceof BrowserApiError ? err.message : "建卷失败，请检查后重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="试卷标题，如《2023 英语一真题》"
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-sm" />
        <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}
          className="rounded border border-[var(--color-border)] px-2 py-1.5 text-sm">
          <option value="考研">考研</option>
          <option value="雅思">雅思</option>
          <option value="通用">通用</option>
        </select>
      </div>

      {sections.map((section, si) => {
        const choice = CHOICE_TYPES.includes(section.questionType);
        const sourceless = SOURCELESS_TYPES.includes(section.questionType);
        return (
          <section key={si} className="space-y-2 rounded-xl border border-[var(--color-border)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--color-ink-soft)]">第 {si + 1} 节</span>
              <input value={section.title} onChange={(e) => patchSection(si, { title: e.target.value })}
                placeholder="节标题，如 Text 1 / Part C 翻译"
                className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-2 py-1 text-sm" />
              <select value={section.questionType}
                onChange={(e) => patchSection(si, { questionType: e.target.value as QuestionType })}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-sm">
                {QUESTION_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
              {sections.length > 1 && (
                <button type="button" onClick={() => setSections((prev) => prev.filter((_, i) => i !== si))}
                  className="text-xs text-[var(--color-danger,#dc2626)]">删节</button>
              )}
            </div>
            {sourceless ? (
              <input value={section.fileKey} onChange={(e) => patchSection(si, { fileKey: e.target.value })}
                placeholder="题组键（可留空，自动按标题生成；同一题组复用同名键）"
                className="w-full rounded border border-[var(--color-border)] px-2 py-1 text-xs" />
            ) : (
              <select value={section.sourceId} onChange={(e) => patchSection(si, { sourceId: e.target.value })}
                className="w-full rounded border border-[var(--color-border)] px-2 py-1 text-xs">
                <option value="">选择阅读材料（先在书架导入正文）…</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            )}

            {section.questions.map((q, qi) => (
              <div key={qi} className="space-y-1.5 rounded-lg bg-[var(--color-surface)] p-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--color-ink-soft)]">Q{qi + 1}</span>
                  <textarea value={q.stem} onChange={(e) => patchQuestion(si, qi, { stem: e.target.value })}
                    rows={2} placeholder="题干"
                    className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-2 py-1 text-sm" />
                  {section.questions.length > 1 && (
                    <button type="button" onClick={() => patchSection(si, { questions: section.questions.filter((_, j) => j !== qi) })}
                      className="text-[11px] text-[var(--color-danger,#dc2626)]">删题</button>
                  )}
                </div>
                {choice ? (
                  <div className="grid gap-1 sm:grid-cols-2">
                    {OPTION_KEYS.map((key) => (
                      <label key={key} className="flex items-center gap-1.5 text-xs">
                        <input type="radio" name={`answer-${si}-${qi}`} value={key} checked={q.answer === key}
                          onChange={() => patchQuestion(si, qi, { answer: key })} />
                        <span>{key}.</span>
                        <input value={q.options[key] ?? ""} onChange={(e) => patchQuestion(si, qi, { options: { ...q.options, [key]: e.target.value } })}
                          placeholder={`选项 ${key}`}
                          className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-1.5 py-1" />
                      </label>
                    ))}
                  </div>
                ) : (
                  <textarea value={q.answerText} onChange={(e) => patchQuestion(si, qi, { answerText: e.target.value })}
                    rows={3} placeholder="参考译文 / 范文与评分要点"
                    className="w-full rounded border border-[var(--color-border)] px-2 py-1 text-xs" />
                )}
              </div>
            ))}
            <button type="button" onClick={() => patchSection(si, { questions: [...section.questions, emptyQuestion()] })}
              className="rounded border border-[var(--color-border)] px-2 py-1 text-xs">+ 加一题</button>
          </section>
        );
      })}

      <div className="flex gap-2">
        <button type="button" onClick={() => setSections((prev) => [...prev, emptySection()])}
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs">+ 加一节</button>
        <button type="button" disabled={saving} onClick={() => void submit()}
          className="rounded bg-[var(--color-accent)] px-4 py-1.5 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">
          {saving ? "提交中…" : "建卷"}
        </button>
      </div>
    </div>
  );
}

/** 档案行时间戳（MM-DD HH:mm；本地口径直读）。 */
function formatArchiveStamp(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * F-1：题纸档案（回看闭环入口）——draft/sealed 新→旧。
 * 「查看解析」走 ?sheet= 深链（只读回看，不新建草稿）；「再做一次」走常规开纸入口。
 */
function ArchiveTab({ onToast }: { onToast: (kind: "success" | "error", msg: string) => void }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<L3SheetArchiveItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setItems(await fetchSheetArchive(100));
    } catch {
      setItems([]);
      setLoadError(true);
      onToast("error", "题纸档案加载失败");
    }
  }, [onToast]);
  useEffect(() => { void load(); }, [load]);

  /** 常规入口（继续作答/再做一次）：走既有开纸路径（draft 冲突复用，幂等）。 */
  const openNormal = (item: L3SheetArchiveItem) => {
    if (item.scope === "file" && item.source_id && item.question_type) {
      navigate(`/l3?venue=${encodeURIComponent(item.question_type)}&file=${encodeURIComponent(item.source_id)}`);
      return;
    }
    if (item.scope === "paper" && item.paper_id) navigate(`/l3?paper=${encodeURIComponent(item.paper_id)}`);
  };

  if (items === null) return <p className="text-sm text-[var(--color-ink-soft)]">加载中…</p>;
  if (loadError && items.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-[var(--color-ink-soft)]">题纸档案加载失败。</p>
        <button type="button" onClick={() => void load()} className="text-xs text-[var(--color-accent)]">重试</button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-ink-soft)]">
        还没有题纸记录。进入任一题型空间开练并定格后，每轮作答都会在这里留下档案，可随时回来查看解析。
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-ink-soft)]">
        共 {items.length} 份题纸 ·「查看解析」只读回看（不新建草稿），「再做一次」开新一轮。
        <button type="button" onClick={() => void load()} className="ml-2 text-[var(--color-accent)]">刷新</button>
      </p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--color-border)] px-3 py-2.5 text-sm">
            <span className="min-w-0 max-w-[16rem] truncate font-medium">{item.venue_title ?? "（来源已删除）"}</span>
            <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)] ring-1 ring-[var(--color-border)]">
              {item.scope === "file" && item.question_type ? TYPE_LABELS[item.question_type as QuestionType] : "整卷"}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${item.status === "sealed" ? "bg-[var(--color-ink)] text-[var(--color-surface)]" : "bg-[var(--color-accent-soft,var(--color-surface))] text-[var(--color-accent)]"}`}>
              {item.status === "sealed" ? "已定格" : "草稿"}
            </span>
            {item.status === "sealed" && (
              <span
                className="text-[10px] text-[var(--color-ink-soft)]"
                data-archive-grading={item.graded_count > 0 ? "graded" : "pending"}
              >
                {item.graded_count > 0 ? `已评 ${item.graded_count} 题` : "待评卷"}
              </span>
            )}
            <span className="text-[10px] text-[var(--color-ink-soft)]">{formatArchiveStamp(item.sealed_at ?? item.created_at)}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
              {item.status === "draft" ? (
                <button type="button" onClick={() => openNormal(item)} className="font-medium text-[var(--color-accent)]">继续作答</button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => navigate(`/l3?sheet=${encodeURIComponent(item.id)}`)}
                    className="font-medium text-[var(--color-accent)]"
                  >
                    查看解析
                  </button>
                  <button type="button" onClick={() => openNormal(item)} className="text-[var(--color-ink-soft)] hover:text-[var(--color-accent)]">再做一次</button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * F-1：题纸回看（?sheet= 深链）——只读指定题纸：GET 单纸 + 组装卷面，
 * 不调 openSheet、不新建草稿（回看闭环的读路径唯一入口）。
 */
function SheetReplayView({ sheetId }: { sheetId: string }) {
  const navigate = useNavigate();
  const [resolved, setResolved] = useState<{
    paper: ExamPaper;
    fileVenue?: { sourceId: string; questionType: QuestionType };
    /** 作文入口方向（file 型查文件列表；paper 型取卷方向；未知值统一归「通用」）。 */
    direction: "通用" | "考研" | "雅思";
    retakePath: string;
    backPath: string;
  } | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setResolved(null);
    (async () => {
      try {
        const { sheet } = await fetchSheet(sheetId);
        if (cancelled) return;
        if (sheet.scope === "file" && sheet.source_id && sheet.question_type) {
          const questionType = sheet.question_type as QuestionType;
          const params = new URLSearchParams({ questionType, sourceId: sheet.source_id });
          const body = await apiFetch<PracticeFileDetail>(`/l3/practice-files/detail?${params}`);
          if (cancelled) return;
          if (!body.source) throw new Error("来源缺失");
          let direction: "通用" | "考研" | "雅思" = "通用";
          try {
            const page = await apiFetch<{ items: PracticeFile[] }>("/l3/practice-files?limit=100");
            direction = toWritingDirection(page.items.find((item) => item.question_type === questionType
              && item.source_id === sheet.source_id)?.direction);
          } catch { /* 方向查询失败降级「通用」；不阻塞回看 */ }
          if (cancelled) return;
          setResolved({
            paper: buildFileVenuePaper(body, sheet.source_id, questionType, body.source.title),
            fileVenue: { sourceId: sheet.source_id, questionType },
            direction,
            retakePath: `/l3?venue=${encodeURIComponent(questionType)}&file=${encodeURIComponent(sheet.source_id)}`,
            backPath: `/l3?venue=${encodeURIComponent(questionType)}`,
          });
          return;
        }
        if (sheet.scope === "paper" && sheet.paper_id) {
          const detail = await apiFetch<ExamPaper>(`/l3/papers/${encodeURIComponent(sheet.paper_id)}`);
          if (cancelled) return;
          setResolved({
            paper: detail,
            direction: toWritingDirection(detail.direction),
            retakePath: `/l3?paper=${encodeURIComponent(sheet.paper_id)}`,
            backPath: "/l3",
          });
          return;
        }
        throw new Error("题纸作用域异常");
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [sheetId, retryNonce]);

  if (error) {
    return (
      <div className="space-y-2">
        <button type="button" onClick={() => navigate("/l3")} className="text-xs text-[var(--color-accent)]">← 返回试卷台</button>
        <p className="text-sm text-[var(--color-ink-soft)]">题纸回看加载失败（题纸可能已删除）。</p>
        <button type="button" onClick={() => setRetryNonce((n) => n + 1)} className="text-xs text-[var(--color-accent)]">重试</button>
      </div>
    );
  }
  if (!resolved) return <p className="text-sm text-[var(--color-ink-soft)]">题纸加载中…</p>;
  return (
    <L3ExamPaper
      paper={resolved.paper}
      {...(resolved.fileVenue ? { fileVenue: resolved.fileVenue } : {})}
      replaySheetId={sheetId}
      writingEntry={{ direction: resolved.direction, onNavigate: (url) => navigate(url) }}
      onBack={() => navigate(resolved.backPath)}
      onRetake={() => navigate(resolved.retakePath)}
    />
  );
}
