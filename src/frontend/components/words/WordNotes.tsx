import { useState, useEffect } from "react";
import { Save, Notebook } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";

interface WordNotesProps {
  slug: string;
}

export function WordNotes({ slug }: WordNotesProps) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    setLoading(true);
    apiFetch<{ content_md: string } | null>(`/words/${slug}/notes`)
      .then((data) => {
        const md = data?.content_md ?? "";
        setContent(md);
        setOriginal(md);
      })
      .catch(() => {
        setContent("");
        setOriginal("");
      })
      .finally(() => setLoading(false));
  }, [slug]);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch(`/words/${slug}/notes`, {
        method: "PUT",
        body: JSON.stringify({ content_md: content }),
      });
      setOriginal(content);
      addToast("success", "笔记已保存");
    } catch {
      addToast("error", "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const dirty = content !== original;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="section-title flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
          <Notebook className="h-5 w-5 text-[var(--color-accent)]" />
          笔记
        </h2>
        {dirty && (
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Spinner className="h-3 w-3" /> : <Save className="h-3 w-3" />}
            保存
          </Button>
        )}
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-[var(--color-ink-soft)]">
          <Spinner className="h-4 w-4" />
          加载笔记...
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="在此输入你的笔记...（支持 Markdown）"
          className="min-h-[120px] w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-input)] p-4 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-soft)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        />
      )}
    </Card>
  );
}
