/**
 * 笔记条目共享 UI（笔记 UX 修复 2026-10-10，设计《ux-notes-redesign》）——
 * 卡背（ReviewCardView·NoteEntriesFold）与详情页（WordNotes）共用：
 *
 *   F1  Markdown 渲染（gfm + breaks 单换行）+ 紧凑 prose 变体（12.5px/1.7）
 *   F2  统一输入区 TA 规格（§5：min-h-[64px] text-[13px]，提取公共常量）
 *   F3  kind 标签：内置 6 类固定配色 + 用户自定义（≤12、中性灰、重名拒绝）；
 *       chip 内联正文首行，`general` 不显示（默认态零噪音）
 *
 * 内置 kind 的 id/标签单一真源在 `@/domain`（NOTE_ENTRY_BUILTIN_KINDS /
 * NOTE_ENTRY_KIND_LABELS），本文件只负责**展示层**（配色 + 选择器 + 渲染）。
 */
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useToast } from "@/frontend/components/ui/Toast";
import {
  isBuiltinNoteEntryKind,
  NOTE_ENTRY_BUILTIN_KINDS,
  NOTE_ENTRY_CUSTOM_KIND_LIMIT,
  NOTE_ENTRY_KIND_LABELS,
  NOTE_ENTRY_KIND_MAX_LENGTH,
  NOTE_ENTRY_KIND_RESERVED_VALUES,
} from "@/domain";

/** 统一输入区规格（设计 §5：卡背/详情页同款）。 */
export const NOTE_ENTRY_TA_CLASS =
  "min-h-[64px] w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-input)] p-3 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-soft)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]";

/** 内置 kind 的展示配色（复用 accent/highlight/中性面，不引入新色）。 */
const BUILTIN_CHIP_CLASSES: Record<string, string> = {
  story: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
  synonym: "bg-[var(--color-accent-subtle)] text-[#8a6a1f]",
  mnemonic: "bg-[var(--color-surface-muted-warm)] text-[var(--color-accent-2)]",
  usage: "bg-[var(--color-surface-muted)] text-[var(--color-accent)]",
  issue:
    "bg-[var(--color-surface-muted-warm)] text-[#8f3d17] border border-[rgba(178,87,47,0.35)]",
};
/** 自定义 kind：统一中性灰。 */
const CUSTOM_CHIP_CLASS = "bg-[var(--color-surface-muted)] text-[var(--color-ink-soft)]";

const CHIP_BASE = "rounded px-1.5 py-px text-[10px] font-semibold leading-[1.6]";

/** kind 展示元数据；`general` 与空值 → null（不显示 chip）。 */
export function noteKindMeta(kind: string | null | undefined): { label: string; chipClass: string } | null {
  if (!kind || kind === "general") return null;
  if (isBuiltinNoteEntryKind(kind)) {
    return {
      label: NOTE_ENTRY_KIND_LABELS[kind],
      chipClass: BUILTIN_CHIP_CLASSES[kind] ?? CUSTOM_CHIP_CLASS,
    };
  }
  return { label: kind, chipClass: CUSTOM_CHIP_CLASS };
}

// ── 用户自定义类型（localStorage 持久；服务端以「单用户 ≤12」兜底校验）──────
const CUSTOM_KINDS_STORAGE_KEY = "note-entry-kinds-v1";

export function loadCustomNoteKinds(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KINDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && v.length <= NOTE_ENTRY_KIND_MAX_LENGTH)
      .filter((v) => !isBuiltinNoteEntryKind(v) && !NOTE_ENTRY_KIND_RESERVED_VALUES.has(v))
      .slice(0, NOTE_ENTRY_CUSTOM_KIND_LIMIT);
  } catch {
    return [];
  }
}

function saveCustomNoteKinds(list: string[]): void {
  try {
    localStorage.setItem(CUSTOM_KINDS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // localStorage 不可用（隐私模式等）：仅影响持久，不影响本次会话
  }
}

/**
 * 紧凑 Markdown 渲染（F1）：gfm + breaks（单换行即 <br>）；kind chip 注入
 * **首段内联**（内容以列表开头时置于容器最前）——不单独占行。
 * marked/dompurify 懒加载（同 `ui/Markdown.tsx` 先例）；渲染失败降级纯文本。
 */
export function NoteEntryContent({
  content,
  kind,
  className = "",
}: {
  content: string;
  kind?: string | null;
  className?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [{ marked }, { default: DOMPurify }] = await Promise.all([
          import("marked"),
          import("dompurify"),
        ]);
        let raw = await marked.parse(content, { gfm: true, breaks: true, async: true });
        const meta = noteKindMeta(kind);
        if (meta) {
          const chip = `<span class="${CHIP_BASE} ${meta.chipClass}">${escapeHtml(meta.label)}</span>`;
          raw = raw.startsWith("<p>") ? raw.replace("<p>", `<p>${chip} `) : `${chip} ${raw}`;
        }
        if (!cancelled) setHtml(DOMPurify.sanitize(raw));
      } catch {
        if (!cancelled) setHtml(`<p>${escapeHtml(content)}</p>`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, kind]);

  // 紧凑 prose 变体（设计 §5：12.5px / 1.7；间距压紧；marker 用 accent）
  const compact =
    "text-[12.5px] leading-[1.7] text-[var(--color-ink)] " +
    "[&_p]:m-0 [&_p]:mb-[0.35em] [&_p:last-child]:mb-0 " +
    "[&_ul]:my-[0.25em] [&_ul]:list-disc [&_ul]:pl-[1.15rem] " +
    "[&_li]:my-[0.1em] [&_li::marker]:text-[var(--color-accent)] " +
    "[&_strong]:font-bold [&_code]:text-[11.5px]";
  if (html === null) {
    return <p className={`${compact} text-[var(--color-ink-soft)] ${className}`}>{content}</p>;
  }
  return <div className={`${compact} ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/**
 * kind 选择器（F3）：内置 6 类 + 自定义（≤12，中性灰）+「＋ 新类型」内联输入
 * （1..16 字，Enter 确认 / Esc 取消；与内置标签或已有类型重名拒绝）。
 * 默认选中 `general`（普通）；选中项通过 `value/onChange` 受控。
 */
export function NoteKindChips({
  value,
  onChange,
}: {
  value: string;
  onChange: (kind: string) => void;
}) {
  const { addToast } = useToast();
  const [customKinds, setCustomKinds] = useState<string[]>(() => loadCustomNoteKinds());
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);

  const allNames = new Set<string>([
    ...NOTE_ENTRY_BUILTIN_KINDS,
    ...Object.values(NOTE_ENTRY_KIND_LABELS),
    ...customKinds,
  ]);

  const confirmNew = () => {
    const name = draft.trim();
    if (!name) {
      setNaming(false);
      setDraft("");
      return;
    }
    if (name.length > NOTE_ENTRY_KIND_MAX_LENGTH) {
      addToast("warning", `类型最长 ${NOTE_ENTRY_KIND_MAX_LENGTH} 字`);
      return;
    }
    if (allNames.has(name)) {
      addToast("info", `与已有类型「${name}」重名`);
      return;
    }
    if (customKinds.length >= NOTE_ENTRY_CUSTOM_KIND_LIMIT) {
      addToast("warning", `自定义类型已达上限 ${NOTE_ENTRY_CUSTOM_KIND_LIMIT}，请先合并相近类型`);
      return;
    }
    const next = [...customKinds, name];
    setCustomKinds(next);
    saveCustomNoteKinds(next);
    onChange(name);
    setNaming(false);
    setDraft("");
    addToast("success", `已创建自定义类型「${name}」`);
  };

  const chipCls = (on: boolean) =>
    `rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
      on
        ? "border-[var(--color-accent)] bg-[var(--color-accent)] font-semibold text-[var(--color-accent-contrast)]"
        : "border-[var(--color-border-strong)] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {NOTE_ENTRY_BUILTIN_KINDS.map((id) => (
        <button
          key={id}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange(id);
          }}
          className={chipCls(value === id)}
        >
          {NOTE_ENTRY_KIND_LABELS[id]}
        </button>
      ))}
      {customKinds.map((name) => (
        <button
          key={name}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange(name);
          }}
          className={chipCls(value === name)}
        >
          {name}
        </button>
      ))}
      {naming ? (
        <input
          ref={inputRef}
          value={draft}
          maxLength={NOTE_ENTRY_KIND_MAX_LENGTH}
          placeholder="类型名…"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              confirmNew();
            } else if (e.key === "Escape") {
              setNaming(false);
              setDraft("");
            }
          }}
          onBlur={confirmNew}
          className="w-[88px] rounded-full border border-[var(--color-accent)] bg-[var(--color-surface-input)] px-2.5 py-0.5 text-[11px] text-[var(--color-ink)] focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setNaming(true);
          }}
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-[var(--color-border-strong)] px-2.5 py-0.5 text-[11px] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus className="h-3 w-3" />
          新类型
        </button>
      )}
    </div>
  );
}
