/**
 * L1 词卡 exam 扩展展示（2026-09-29）。
 *
 * 定位：**低频深读区，不是提示**。默认折叠，展开**不计入**提示阶梯级数、
 * 不改变 `hintLevel`、不影响评分上限——阶梯的价值是低成本回忆，exam 是
 * 已经记住之后的精读。两者混在一起会把阶梯变成"上课"（见
 * docs/handoff/round-2026-09-29-facts.md §7.10 的 hintLevel 语义）。
 *
 * 复用方：复习卡（ReviewCardView）与词条详情页（WordDetailPage），
 * 两侧 API 形状一致（都带 `examples[].exam`），故共用本组件与同一解析器
 * （`@/domain/word-exam`）。
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { WordExam } from "@/domain/word-exam";
import { ExamSplitText } from "@/frontend/components/words/ExamSplitText";

function LayerShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-3 py-2.5">
      <h4 className="mb-1.5 text-[12px] font-semibold tracking-wide text-[var(--color-ink-soft)]">
        {title}
      </h4>
      {children}
    </section>
  );
}

/** 角色徽标：main = 主干，mod = 修饰。类别未知时不渲染徽标（不猜语义）。 */
function RoleBadge({ role, roleKind }: { role: string | null; roleKind: "main" | "mod" | null }) {
  if (role === null) return null;
  const tone =
    roleKind === "main"
      ? "border-[var(--color-accent)]/40 text-[var(--color-accent)]"
      : roleKind === "mod"
        ? "border-[var(--color-border)] text-[var(--color-ink-soft)]"
        : "border-[var(--color-border)] text-[var(--color-ink-soft)]";
  return (
    <span
      className={`shrink-0 rounded border px-1 py-px text-[10px] leading-tight ${tone}`}
      data-testid={`exam-role-${roleKind ?? "unknown"}`}
    >
      {role}
    </span>
  );
}

export function WordExamPanel({
  exam,
  defaultOpen = false,
  className = "",
}: {
  exam: WordExam | null;
  /** 默认展开。词条详情页可传 true（那里用户本就在细读），复习卡保持折叠。 */
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!exam) return null;

  const { reading, translation, writing } = exam;
  const layerCount =
    (reading ? 1 : 0) + (translation ? 1 : 0) + (writing ? 1 : 0);
  if (layerCount === 0) return null;

  return (
    <div className={className} data-testid="word-exam-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="word-exam-toggle"
        className="flex w-full items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/50"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-[var(--color-ink-soft)] transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-[13px] font-semibold text-[var(--color-ink)]">例句精讲</span>
        <span className="text-[11px] text-[var(--color-ink-soft)]">
          逐块语法 · 译解 · 句式
        </span>
        <span className="ml-auto text-[10px] text-[var(--color-ink-soft)] opacity-70">
          不计入提示阶梯
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-2.5" data-testid="word-exam-body">
          {reading && (
            <LayerShell title="精读 · 逐块与语法角色">
              <ol className="space-y-1.5" data-testid="word-exam-reading">
                {reading.blocks.map((b, i) => (
                  <li key={`${b.text.slice(0, 20)}-${i}`} className="flex items-start gap-2">
                    <RoleBadge role={b.role} roleKind={b.roleKind} />
                    <span className="text-[13px] leading-relaxed text-[var(--color-ink)]">
                      {/* 渲染 segments 而非 b.text：`[]` 与 `｜定` 是数据编码，
                          直接渲染原文会把它们漏给读者（与复习卡同源的问题）。 */}
                      <ExamSplitText segments={b.segments} />
                    </span>
                  </li>
                ))}
              </ol>
              {reading.structure && (
                <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--color-ink-soft)]">
                  {reading.structure}
                </p>
              )}
            </LayerShell>
          )}

          {translation && (
            <LayerShell title="译解 · 逐块标签解析">
              {translation.model && (
                <p className="mb-2 text-[12.5px] leading-relaxed text-[var(--color-ink)]">
                  {translation.model}
                </p>
              )}
              <ul className="space-y-1.5">
                {translation.keyPoints.map((kp, i) => (
                  <li key={`${kp.tag}-${i}`} data-testid="exam-key-point">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span
                        className="rounded bg-[var(--color-accent-soft)] px-1.5 py-px text-[10.5px] font-semibold text-[var(--color-accent)]"
                      >
                        {kp.tag}
                      </span>
                      {kp.kind && (
                        <span className="text-[10px] text-[var(--color-ink-soft)] opacity-70">
                          {kp.kind}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-ink)]">
                      {kp.text}
                      <span className="mx-1.5 text-[var(--color-ink-soft)] opacity-60">·</span>
                      <span className="text-[var(--color-ink-soft)]">{kp.translation}</span>
                    </p>
                    {kp.note && (
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-ink-soft)]">
                        {kp.note}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </LayerShell>
          )}

          {writing && (
            <LayerShell title="仿写 · 可套用句式">
              {writing.functionLabel && (
                <p className="mb-1 text-[11.5px] text-[var(--color-ink-soft)]">
                  适用场景：{writing.functionLabel}
                </p>
              )}
              {writing.pattern && (
                <p
                  className="rounded bg-[var(--color-surface)] px-2 py-1.5 font-mono text-[12px] leading-relaxed text-[var(--color-ink)]"
                  data-testid="exam-writing-pattern"
                >
                  {writing.pattern}
                </p>
              )}
              {writing.imitatingExample && (
                <p
                  className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-ink)]"
                  data-testid="exam-imitating-example"
                >
                  {writing.imitatingExample}
                </p>
              )}
              {writing.usage && (
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--color-ink-soft)]">
                  {writing.usage}
                </p>
              )}
            </LayerShell>
          )}
        </div>
      )}
    </div>
  );
}
