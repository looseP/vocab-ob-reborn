import { useState } from "react";
import { Upload, FileJson, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";

interface ImportWord {
  lemma: string;
  pos?: string;
  cefr?: string;
  ipa?: string;
  short_definition?: string;
}

const SAMPLE_JSON = `[
  {"lemma": "abandon", "pos": "verb", "cefr": "B1", "ipa": "/əˈbændən/", "short_definition": "To leave completely"},
  {"lemma": "benefit", "pos": "noun", "cefr": "A2", "ipa": "/ˈbenɪfɪt/", "short_definition": "An advantage or profit"}
]`;

export function ImportPage() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ImportWord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ inserted: number } | null>(null);
  const { addToast } = useToast();

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

  const handleImport = async () => {
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">批量导入</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">粘贴 JSON 数组格式的单词数据</p>
      </div>

      {/* 输入区 */}
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
            <Button variant="primary" onClick={handleImport} disabled={importing}>
              <Upload className="h-4 w-4" />
              {importing ? "导入中..." : `导入 ${parsed.length} 个单词`}
            </Button>
          )}
        </div>
      </Card>

      {/* 错误提示 */}
      {error && (
        <Card className="border-[var(--color-accent-2)]">
          <div className="flex items-center gap-2 text-[var(--color-accent-2)]">
            <AlertCircle className="h-5 w-5" />
            <span className="font-medium">{error}</span>
          </div>
        </Card>
      )}

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
    </div>
  );
}
