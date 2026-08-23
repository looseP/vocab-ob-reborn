import { useCallback, useRef, useState } from "react";
import { Upload, FileJson, FileText, CheckCircle2, AlertCircle, Trash2, Loader2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";

// ── Types ───────────────────────────────────────────────────────────────

type Strictness = "lenient" | "standard" | "strict";

interface ImportWord {
  lemma: string;
  pos?: string;
  cefr?: string;
  ipa?: string;
  short_definition?: string;
}

interface NoteFileEntry {
  id: string;
  path: string;
  content: string;
  updatedAt: string;
  size: number;
}

type FileStatus = "imported" | "unchanged" | "needs_supplement" | "rejected" | "failed";

interface VocabNoteFileResult {
  path: string;
  status: FileStatus;
  total: number;
  imported: number;
  unchanged: number;
  needsSupplement: number;
  rejected: number;
  failedWords: number;
  minScore: number | null;
  issues: string[];
  error?: string;
}

interface VocabNotesImportStats {
  files: number;
  imported: number;
  unchanged: number;
  needsSupplement: number;
  rejected: number;
  failed: number;
}

interface VocabNotesImportResult {
  results: VocabNoteFileResult[];
  stats: VocabNotesImportStats;
}

// ── Request chunking (server caps: 50 files/request, 1 MiB body) ────────

const MAX_FILES_PER_REQUEST = 50;
const MAX_REQUEST_BODY_BYTES = 700 * 1024;
const encoder = new TextEncoder();

function chunkNoteFiles(files: NoteFileEntry[]): NoteFileEntry[][] {
  const chunks: NoteFileEntry[][] = [];
  let current: NoteFileEntry[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const fileBytes = encoder.encode(JSON.stringify(file)).byteLength;
    const overflow =
      current.length >= MAX_FILES_PER_REQUEST ||
      (current.length > 0 && currentBytes + fileBytes + 128 > MAX_REQUEST_BODY_BYTES);
    if (overflow) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += fileBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function emptyStats(): VocabNotesImportStats {
  return { files: 0, imported: 0, unchanged: 0, needsSupplement: 0, rejected: 0, failed: 0 };
}

function mergeStats(target: VocabNotesImportStats, delta: VocabNotesImportStats): void {
  target.files += delta.files;
  target.imported += delta.imported;
  target.unchanged += delta.unchanged;
  target.needsSupplement += delta.needsSupplement;
  target.rejected += delta.rejected;
  target.failed += delta.failed;
}

const STATUS_LABELS: Record<FileStatus, string> = {
  imported: "已导入",
  unchanged: "无变化",
  needs_supplement: "待补充",
  rejected: "已拒绝",
  failed: "失败",
};

const STATUS_TONES: Record<FileStatus, "default" | "warm" | "accent"> = {
  imported: "accent",
  unchanged: "default",
  needs_supplement: "warm",
  rejected: "warm",
  failed: "warm",
};

// ── Component ───────────────────────────────────────────────────────────

const SAMPLE_JSON = `[
  {"lemma": "abandon", "pos": "verb", "cefr": "B1", "ipa": "/əˈbændən/", "short_definition": "To leave completely"},
  {"lemma": "benefit", "pos": "noun", "cefr": "A2", "ipa": "/ˈbenɪfɪt/", "short_definition": "An advantage or profit"}
]`;

export function ImportPage() {
  const [tab, setTab] = useState<"upload" | "json">("upload");

  // Upload tab state
  const [entries, setEntries] = useState<NoteFileEntry[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [strictness, setStrictness] = useState<Strictness>("standard");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [noteResults, setNoteResults] = useState<VocabNoteFileResult[]>([]);
  const [noteStats, setNoteStats] = useState<VocabNotesImportStats | null>(null);

  // JSON tab state
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ImportWord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ inserted: number } | null>(null);

  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setReadingFiles(true);
    setError(null);
    try {
      const markdownFiles = Array.from(fileList).filter(
        (f) => f.name.endsWith(".md") && f.name !== "README.md",
      );
      if (markdownFiles.length === 0) {
        setError("未选择 Markdown 笔记文件（仅支持 .md）");
        return;
      }
      const loaded: NoteFileEntry[] = [];
      for (const file of markdownFiles) {
        const content = await file.text();
        loaded.push({
          id: `${file.name}:${file.lastModified}:${file.size}`,
          path: file.webkitRelativePath || file.name,
          content,
          updatedAt: new Date(file.lastModified).toISOString(),
          size: file.size,
        });
      }
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.path));
        return [...prev, ...loaded.filter((e) => !seen.has(e.path))];
      });
      setNoteResults([]);
      setNoteStats(null);
    } finally {
      setReadingFiles(false);
    }
  }, []);

  const clearFiles = () => {
    setEntries([]);
    setNoteResults([]);
    setNoteStats(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const runNoteImport = async (asPreview: boolean) => {
    if (entries.length === 0 || uploading) return;
    setUploading(true);
    setError(null);
    setProgress({ done: 0, total: entries.length });
    try {
      const chunks = chunkNoteFiles(entries);
      const results: VocabNoteFileResult[] = [];
      const stats = emptyStats();
      for (const chunk of chunks) {
        const res = await apiFetch<VocabNotesImportResult>("/imports/vocab-notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: chunk, dryRun: asPreview, strictness }),
        });
        results.push(...res.results);
        mergeStats(stats, res.stats);
        setProgress((p) => ({ done: Math.min(entries.length, (p?.done ?? 0) + chunk.length), total: entries.length }));
      }
      setPreviewMode(asPreview);
      setNoteResults(results);
      setNoteStats(stats);
      if (stats.failed === 0 && stats.rejected === 0) {
        addToast(
          "success",
          asPreview
            ? `预览完成：${stats.imported} 个词条将导入，${stats.unchanged} 个无变化`
            : `成功处理 ${stats.files} 个文件：导入 ${stats.imported} 个词条`,
        );
      } else {
        addToast("warning", `完成，但有 ${stats.failed} 个文件失败、${stats.rejected} 个词条被拒绝`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
      addToast("error", "导入失败");
    } finally {
      setUploading(false);
      setProgress(null);
    }
  };

  const parseJson = () => {
    setError(null);
    setResult(null);
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) {
        setError("JSON 必须是数组格式");
        setParsed(null);
        return;
      }
      const words = data.filter((w: Record<string, unknown>) => w.lemma || w.title);
      if (words.length === 0) {
        setError("未找到有效的单词（需要 lemma 或 title 字段）");
        setParsed(null);
        return;
      }
      setParsed(words as ImportWord[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "JSON 解析失败");
      setParsed(null);
    }
  };

  const handleJsonImport = async () => {
    if (!parsed || parsed.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await apiFetch<{ inserted: number }>("/words/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ words: parsed }),
      });
      setResult(res);
      addToast("success", `成功导入 ${res.inserted} 个单词`);
      setParsed(null);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
      addToast("error", "导入失败");
    } finally {
      setImporting(false);
    }
  };

  const loadSample = () => {
    setText(SAMPLE_JSON);
    setParsed(null);
    setError(null);
    setResult(null);
  };

  const clearAll = () => {
    setText("");
    setParsed(null);
    setError(null);
    setResult(null);
  };

  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">批量导入</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">上传 L1 收藏集笔记（Markdown），或粘贴 JSON 单词数组</p>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-2">
        <Button
          variant={tab === "upload" ? "primary" : "secondary"}
          size="sm"
          onClick={() => { setTab("upload"); setError(null); }}
        >
          <FileText className="h-4 w-4" /> 笔记文件上传
        </Button>
        <Button
          variant={tab === "json" ? "primary" : "secondary"}
          size="sm"
          onClick={() => { setTab("json"); setError(null); }}
        >
          <FileJson className="h-4 w-4" /> JSON 粘贴
        </Button>
      </div>

      {/* 错误提示 */}
      {error && (
        <Card className="border-[var(--color-accent-2)]">
          <div className="flex items-center gap-2 text-[var(--color-accent-2)]">
            <AlertCircle className="h-5 w-5" />
            <span className="font-medium">{error}</span>
          </div>
        </Card>
      )}

      {tab === "upload" && (
        <>
          {/* 文件选择区 */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-[var(--color-accent)]" />
                <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">L1 收藏集笔记</h2>
              </div>
              {entries.length > 0 && (
                <Button size="sm" variant="ghost" onClick={clearFiles}>
                  <Trash2 className="h-4 w-4" /> 清空
                </Button>
              )}
            </div>

            <label
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-input)] p-8 text-center transition-colors hover:border-[var(--color-accent)]"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}
            >
              {readingFiles ? (
                <Loader2 className="h-6 w-6 animate-spin text-[var(--color-accent)]" />
              ) : (
                <Upload className="h-6 w-6 text-[var(--color-ink-soft)]" />
              )}
              <span className="text-sm font-medium text-[var(--color-ink)]">
                {readingFiles ? "正在读取文件..." : "点击选择或拖拽 .md 文件到此处"}
              </span>
              <span className="text-xs text-[var(--color-ink-soft)]">
                支持多选；README.md 与非 .md 文件自动忽略
              </span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".md,text/markdown"
                className="hidden"
                onChange={(e) => void addFiles(e.target.files)}
              />
            </label>

            {entries.length > 0 && (
              <div className="mt-3 space-y-3">
                <div className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
                  <Badge tone="accent">{entries.length} 个文件</Badge>
                  <span>共 {(totalBytes / 1024).toFixed(1)} KB</span>
                </div>
                <div className="max-h-48 overflow-y-auto rounded-xl border border-[var(--color-border)]">
                  <table className="w-full text-sm">
                    <tbody>
                      {entries.slice(0, 100).map((entry) => (
                        <tr key={entry.id} className="border-b border-[var(--color-border)] last:border-b-0">
                          <td className="px-3 py-1.5 font-mono text-xs text-[var(--color-ink)]">{entry.path}</td>
                          <td className="px-3 py-1.5 text-right text-xs text-[var(--color-ink-soft)]">
                            {(entry.size / 1024).toFixed(1)} KB
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {entries.length > 100 && (
                    <p className="px-3 py-1.5 text-xs text-[var(--color-ink-soft)]">
                      还有 {entries.length - 100} 个文件未显示...
                    </p>
                  )}
                </div>

                {/* 导入选项 */}
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-[var(--color-ink)]">
                    <input
                      type="checkbox"
                      checked={dryRun}
                      onChange={(e) => setDryRun(e.target.checked)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    预览模式（不写入数据库）
                  </label>
                  <label className="flex items-center gap-2 text-sm text-[var(--color-ink)]">
                    质量门槛
                    <select
                      value={strictness}
                      onChange={(e) => setStrictness(e.target.value as Strictness)}
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-input)] px-2 py-1 text-sm text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none"
                    >
                      <option value="lenient">宽松</option>
                      <option value="standard">标准</option>
                      <option value="strict">严格</option>
                    </select>
                  </label>
                </div>

                <div className="flex items-center gap-3">
                  <Button
                    onClick={() => void runNoteImport(true)}
                    disabled={uploading || entries.length === 0}
                  >
                    预览解析
                  </Button>
                  {!dryRun && (
                    <Button variant="primary" onClick={() => void runNoteImport(false)} disabled={uploading || entries.length === 0}>
                      {uploading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          导入中 ({progress?.done ?? 0}/{progress?.total ?? entries.length})
                        </>
                      ) : (
                        <>
                          <Upload className="h-4 w-4" />
                          导入 {entries.length} 个文件
                        </>
                      )}
                    </Button>
                  )}
                  {dryRun && (
                    <span className="text-xs text-[var(--color-ink-soft)]">
                      预览模式已启用：点击「预览解析」计算结果，不会写入数据库
                    </span>
                  )}
                </div>
                {progress && progress.done < progress.total && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)] transition-all"
                      style={{ width: `${Math.round(((progress.done / Math.max(progress.total, 1)) * 100))}%` }}
                    />
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* 导入结果 */}
          {noteStats && (
            <Card className={noteStats.failed > 0 || noteStats.rejected > 0 ? "border-[var(--color-accent-2)]" : "border-[var(--color-accent)]"}>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                {noteStats.failed > 0 || noteStats.rejected > 0 ? (
                  <AlertCircle className="h-5 w-5 text-[var(--color-accent-2)]" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 text-[var(--color-accent)]" />
                )}
                <span className="text-lg font-semibold text-[var(--color-ink)]">
                  {previewMode ? "预览结果（未写入）" : "导入结果"}
                </span>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge tone="accent">导入 {noteStats.imported}</Badge>
                  <Badge>无变化 {noteStats.unchanged}</Badge>
                  {noteStats.needsSupplement > 0 && <Badge tone="warm">待补充 {noteStats.needsSupplement}</Badge>}
                  {noteStats.rejected > 0 && <Badge tone="warm">拒绝 {noteStats.rejected}</Badge>}
                  {noteStats.failed > 0 && <Badge tone="warm">失败文件 {noteStats.failed}</Badge>}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-ink-soft)]">
                      <th className="pb-2 pr-4">文件</th>
                      <th className="pb-2 pr-4">状态</th>
                      <th className="pb-2 pr-4">词条</th>
                      <th className="pb-2 pr-4">最低分</th>
                      <th className="pb-2">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {noteResults.map((r) => (
                      <tr key={r.path} className="border-b border-[var(--color-border)] align-top">
                        <td className="py-2 pr-4 font-mono text-xs text-[var(--color-ink)]">{r.path}</td>
                        <td className="py-2 pr-4"><Badge tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Badge></td>
                        <td className="py-2 pr-4 text-xs text-[var(--color-ink-soft)]">
                          导入 {r.imported} / 无变化 {r.unchanged} / 拒绝 {r.rejected}
                          {r.needsSupplement > 0 && ` / 待补 ${r.needsSupplement}`}
                        </td>
                        <td className="py-2 pr-4 text-xs text-[var(--color-ink-soft)]">{r.minScore ?? "—"}</td>
                        <td className="py-2 text-xs text-[var(--color-ink-soft)]">
                          {r.error ?? r.issues.slice(0, 3).join("；")}{r.issues.length > 3 ? ` 等 ${r.issues.length} 条` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* 格式说明 */}
          <Card>
            <h2 className="section-title mb-3 text-lg font-semibold text-[var(--color-ink)]">收藏集笔记格式</h2>
            <div className="space-y-2 text-sm text-[var(--color-ink-soft)]">
              <p>每个文件是一篇收藏集笔记：<code className="rounded bg-[var(--color-surface-muted)] px-1"># 标题</code> + 多个 <code className="rounded bg-[var(--color-surface-muted)] px-1">## 词头</code> 小节。</p>
              <ul className="ml-4 list-disc space-y-1">
                <li><code className="rounded bg-[var(--color-surface-muted)] px-1">Identity</code> — lemma / pos / ipa 等身份字段</li>
                <li><code className="rounded bg-[var(--color-surface-muted)] px-1">Short Definition</code> — 一句话核心释义（质量门槛必填）</li>
                <li><code className="rounded bg-[var(--color-surface-muted)] px-1">Core Definitions</code> — 分义项编号列表</li>
              </ul>
              <p className="mt-2">相同内容的重复上传按 hash 幂等跳过（unchanged），可放心复跑。质量不足的词条按门槛标记为「待补充」或「拒绝」。</p>
            </div>
          </Card>
        </>
      )}

      {tab === "json" && (
        <>
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileJson className="h-5 w-5 text-[var(--color-accent)]" />
                <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">JSON 输入</h2>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={loadSample}>加载示例</Button>
                <Button size="sm" variant="ghost" onClick={clearAll}>
                  <Trash2 className="h-4 w-4" /> 清空
                </Button>
              </div>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='[{"lemma": "abandon", "pos": "verb", "cefr": "B1", "short_definition": "To leave completely"}]'
              className="h-48 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-input)] p-4 font-mono text-sm text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none"
            />
            <div className="mt-3 flex items-center gap-3">
              <Button onClick={parseJson} disabled={!text.trim()}>
                <FileJson className="h-4 w-4" /> 解析预览
              </Button>
              {parsed && parsed.length > 0 && (
                <Button variant="primary" onClick={handleJsonImport} disabled={importing}>
                  <Upload className="h-4 w-4" />
                  {importing ? "导入中..." : `导入 ${parsed.length} 个单词`}
                </Button>
              )}
            </div>
          </Card>

          {/* 导入结果 */}
          {result && (
            <Card className="border-[var(--color-accent)]">
              <div className="flex items-center gap-2 text-[var(--color-accent)]">
                <CheckCircle2 className="h-6 w-6" />
                <span className="text-lg font-semibold">成功导入 {result.inserted} 个单词</span>
              </div>
            </Card>
          )}

          {/* 预览表格 */}
          {parsed && parsed.length > 0 && (
            <Card>
              <div className="mb-4 flex items-center gap-2">
                <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">
                  预览 ({parsed.length} 个单词)
                </h2>
                <Badge tone="accent">待导入</Badge>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-ink-soft)]">
                      <th className="pb-2 pr-4">单词</th>
                      <th className="pb-2 pr-4">词性</th>
                      <th className="pb-2 pr-4">CEFR</th>
                      <th className="pb-2 pr-4">音标</th>
                      <th className="pb-2">释义</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 20).map((w, i) => (
                      <tr key={i} className="border-b border-[var(--color-border)]">
                        <td className="py-2 pr-4 font-medium text-[var(--color-ink)]">{w.lemma}</td>
                        <td className="py-2 pr-4 text-[var(--color-ink-soft)]">{w.pos ?? "—"}</td>
                        <td className="py-2 pr-4 text-[var(--color-ink-soft)]">{w.cefr ?? "—"}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-[var(--color-ink-soft)]">{w.ipa ?? "—"}</td>
                        <td className="py-2 text-[var(--color-ink-soft)]">{w.short_definition ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsed.length > 20 && (
                  <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                    还有 {parsed.length - 20} 个单词未显示...
                  </p>
                )}
              </div>
            </Card>
          )}

          {/* 格式说明 */}
          <Card>
            <h2 className="section-title mb-3 text-lg font-semibold text-[var(--color-ink)]">JSON 格式说明</h2>
            <div className="space-y-2 text-sm text-[var(--color-ink-soft)]">
              <p>每个单词对象支持以下字段：</p>
              <ul className="ml-4 list-disc space-y-1">
                <li><code className="rounded bg-[var(--color-surface-muted)] px-1">lemma</code>（必填）— 单词原形</li>
                <li><code className="rounded bg-[var(--color-surface-muted)] px-1">pos</code>（可选）— 词性（verb/noun/adjective 等）</li>
                <li><code className="rounded bg-[var(--color-surface-muted)] px-1">cefr</code>（可选）— CEFR 等级（A1-C2）</li>
                <li><code className="rounded bg-[var(--color-surface-muted)] px-1">ipa</code>（可选）— 音标</li>
                <li><code className="rounded bg-[var(--color-surface-muted)] px-1">short_definition</code>（可选）— 简短释义</li>
              </ul>
              <p className="mt-2">最多支持 500 个单词/批次。重复的 slug 会自动更新。</p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
