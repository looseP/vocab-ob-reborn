import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { useToast } from "@/frontend/components/ui/Toast";
import { L3ExamPaper, type ExamPaper } from "@/frontend/components/l3/L3ExamPaper";

/**
 * 试卷台（ADR-0030 V1 最小可用面）：
 *  - 题型空间：七题型 chips → 派生做题文件列表 → 文件题组详情；
 *  - 我的试卷：卷列表 → 卷面组装详情（缺失引用降级占位）；
 *  - 粘贴建卷：owner 直写表单（section × 题 × 选项/答案），提交后自动落能力域标签。
 * 做题表面（三模式/自动草稿）在 V2，本页只负责入库与浏览。
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
const CHOICE_TYPES: QuestionType[] = ["cloze", "reading_choice", "new_question", "grammar_blank"];
const OPTION_KEYS = ["A", "B", "C", "D"] as const;

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

function QuestionList({ questions }: { questions: QuestionRow[] }) {
  if (questions.length === 0) return <p className="text-xs text-[var(--color-ink-soft)]">（无题）</p>;
  return (
    <ol className="space-y-2">
      {questions.map((q) => (
        <li key={q.id} className="rounded-lg border border-[var(--color-border)] p-2.5">
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
        </li>
      ))}
    </ol>
  );
}

export function L3PapersPage({ deepLinkVenue, deepLinkFile }: {
  /** 批次二深链：?venue=<题型>&file=<文件键> 直达题型空间并自动打开目标文件。 */
  deepLinkVenue?: string | null;
  deepLinkFile?: string | null;
} = {}) {
  const { addToast } = useToast();
  const hasFilesDeepLink = Boolean(deepLinkVenue && QUESTION_TYPES.includes(deepLinkVenue as QuestionType));
  const [tab, setTab] = useState<"files" | "papers" | "build">(hasFilesDeepLink ? "files" : "papers");

  return (
    <div className="space-y-3">
      <div>
        <p className="eyebrow">试卷工作台</p>
        <h2 className="text-lg font-semibold">试卷台</h2>
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {([["files", "题型空间"], ["papers", "我的试卷"], ["build", "粘贴建卷"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`rounded-full px-3 py-1 text-xs ${tab === id ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]" : "border border-[var(--color-border)] text-[var(--color-ink-soft)]"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "files" && (
        <FilesTab deepLink={hasFilesDeepLink ? { venue: deepLinkVenue as QuestionType, file: deepLinkFile ?? null } : null} />
      )}
      {tab === "papers" && <PapersTab onToast={addToast} />}
      {tab === "build" && <BuildTab onBuilt={() => setTab("papers")} onToast={addToast} />}
    </div>
  );
}

function FilesTab({ deepLink }: { deepLink?: { venue: QuestionType; file: string | null } | null } = {}) {
  const { addToast } = useToast();
  const [files, setFiles] = useState<PracticeFile[] | null>(null);
  const [venue, setVenue] = useState<QuestionType | null>(deepLink?.venue ?? null);
  const [detail, setDetail] = useState<{ title: string; body: { questions: QuestionRow[] } } | null>(null);
  const [pendingFileKey, setPendingFileKey] = useState<string | null>(deepLink?.file ?? null);

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
      const body = await apiFetch<{ questions: QuestionRow[] }>(`/l3/practice-files/detail?${params}`);
      setDetail({ title: file.title, body });
    } catch {
      addToast("error", "文件题组加载失败");
    }
  };

  // 批次二深链：文件列表就绪后自动打开目标文件（?venue=<题型>&file=<source_id|file_key>）。
  const openFileRef = useRef<typeof openFile | null>(null);
  useEffect(() => { openFileRef.current = openFile; });
  useEffect(() => {
    if (!pendingFileKey || !venue || !files) return;
    const target = files.find((file) => file.question_type === venue
      && (file.source_id === pendingFileKey || file.file_key === pendingFileKey));
    setPendingFileKey(null);
    if (target) void openFileRef.current?.(target);
  }, [pendingFileKey, venue, files]);

  // 三级：文件题组详情
  if (detail && venue) {
    return (
      <div className="space-y-2">
        <button type="button" onClick={() => setDetail(null)} className="text-xs text-[var(--color-accent)]">← 返回{VENUES.find((v) => v.type === venue)?.name}空间</button>
        <h3 className="text-base font-semibold">{detail.title}</h3>
        <QuestionList questions={detail.body.questions} />
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

function PapersTab({ onToast }: { onToast: (kind: "success" | "error", msg: string) => void }) {
  const [papers, setPapers] = useState<PaperListItem[] | null>(null);
  const [detail, setDetail] = useState<ExamPaper | null>(null);

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
      setDetail(await apiFetch<ExamPaper>(`/l3/papers/${id}`));
    } catch {
      onToast("error", "试卷详情加载失败");
    }
  };

  if (detail) {
    return <L3ExamPaper paper={detail} onBack={() => setDetail(null)} />;
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
