import { useEffect, useState } from "react";

/**
 * Renders markdown with the app's `.prose-obsidian` typography.
 * `marked` + `dompurify` are lazy-loaded on first use so they stay out of
 * the main bundle; output is always sanitized before touching the DOM.
 */
export function Markdown({ content, className = "" }: { content: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [{ marked }, { default: DOMPurify }] = await Promise.all([
          import("marked"),
          import("dompurify"),
        ]);
        const raw = await marked.parse(content, { gfm: true, breaks: true, async: true });
        if (!cancelled) setHtml(DOMPurify.sanitize(raw));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [content]);
  if (failed) {
    return <p className={`text-sm text-[var(--color-accent-2)] ${className}`}>Markdown 渲染失败。</p>;
  }
  if (html === null) {
    return <p className={`text-sm text-[var(--color-ink-soft)] ${className}`}>正在渲染...</p>;
  }
  return (
    <div
      className={`prose-obsidian text-sm ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
