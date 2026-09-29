import clsx from "clsx";
import { Badge } from "@/frontend/components/ui/Badge";

/**
 * 核心释义义项列表（结构化渲染，替代 `definition_md` 的 markdown 平铺）。
 *
 * ## 为什么不用 `definition_md`
 *
 * `definition_md` 是 `core_definitions` 的**有损 markdown 投影**：导入器
 * （`src/domain/ingest/collection-parser.ts:183` `renderDefinitionMd`）把每个义项
 * 压成 `N. 义项` + `- en:` / `- priority:` / `- tags:` 三个 bullet。渲染出来是
 * **每个义项 4 行**的松散列表 —— 而 `priority` 与 `tags` 是**结构化元数据**，
 * 本该按属性呈现，不该各占一整行。
 *
 * 数据侧零改动：`core_definitions` 覆盖 6767/6767 词（与 `definition_md` 同为
 * 100%），`definition_md` 仍作为无 `core_definitions` 时的降级路径。
 *
 * ## 紧凑度约定
 *
 * - 义项**两行**：`义项（中文）` + `en（英文）`。
 * - `tags` 提到义项行**右端**，与义项同行 —— 它是分类标签，不是独立信息。
 * - `priority` **默认不显示**：`parseCoreDefinitions` 内部已 `sortByPriority`
 *   （`collection-parser.ts:164`），列表顺序本身即是优先级表达，单独再写一遍
 *   `priority: 1` 是纯冗余。仅当它与「序号隐含的权重」不一致时才出徽章
 *   （正常数据不会发生，见 `weightMismatch`），以免静默丢信息。
 */

export interface CoreSense {
  sense: string;
  en: string | null;
  priority: number | null;
  tags: string[];
}

interface SenseListProps {
  senses: CoreSense[] | null | undefined;
  className?: string;
  /** 义项文字色，默认取正文墨色。 */
  dense?: boolean;
}

export function SenseList({ senses, className, dense = false }: SenseListProps) {
  if (!senses || senses.length === 0) return null;
  // 单义项时序号 "1" 是噪音（没有兄弟可比），不渲染序号列。
  const showIndex = senses.length > 1;
  const textSize = dense ? "text-[12.5px]" : "text-[13.5px]";
  const enSize = dense ? "text-[11.5px]" : "text-[12.5px]";

  return (
    <ol
      data-testid="sense-list"
      className={clsx("space-y-1.5", className)}
    >
      {senses.map((d, i) => {
        const tags = d.tags.filter((t) => t.trim().length > 0);
        // 序号已按 priority 升序；这里只捕捉「实际权重 ≠ 位置」的异常。
        const weightMismatch = d.priority != null && d.priority !== i + 1;
        return (
          <li
            key={`${d.sense}-${i}`}
            className="flex items-start gap-1.5"
          >
            {showIndex && (
              <span
                aria-hidden
                className={clsx(
                  "w-4 shrink-0 pt-[1px] text-right text-[11.5px] tabular-nums",
                  i === 0
                    ? "font-semibold text-[var(--color-accent)]"
                    : "text-[var(--color-ink-soft)]",
                )}
              >
                {i + 1}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p
                  className={clsx(
                    "min-w-0 leading-snug text-[var(--color-ink)]",
                    textSize,
                    i === 0 && "font-medium",
                  )}
                >
                  {d.sense}
                </p>
                {(tags.length > 0 || weightMismatch) && (
                  <span className="flex shrink-0 flex-wrap items-center justify-end gap-1 pt-[1px]">
                    {weightMismatch && (
                      <Badge tone="warm" className="px-1.5 py-0 text-[10px]">
                        权重 {d.priority}
                      </Badge>
                    )}
                    {tags.map((t) => (
                      <Badge
                        key={t}
                        // tags 是分类标签而非分级，**不按值映射颜色** ——
                        // 那会暗示一种数据里并不存在的语义顺序（同义标签颜色不同）。
                        className="px-1.5 py-0 text-[10px]"
                      >
                        {t}
                      </Badge>
                    ))}
                  </span>
                )}
              </div>
              {d.en && (
                <p
                  className={clsx(
                    "mt-0.5 leading-snug text-[var(--color-ink-soft)]",
                    enSize,
                  )}
                >
                  {d.en}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
