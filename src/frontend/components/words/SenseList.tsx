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
 * - `priority` **不显示**：`parseCoreDefinitions` 内部已 `sortByPriority`
 *   （`collection-parser.ts:164`），列表顺序本身即是优先级表达，单独再写一遍
 *   `priority: 1` 是纯冗余。仅当它与「序号隐含的权重」不一致时才出徽章
 *   （正常数据不会发生，见 `weightMismatch`），以免静默丢信息。
 * - `tags` **不显示**（2026-09-29 二次核查后移除，理由见下）。
 *
 * ## 为什么 `tags` 不显示
 *
 * 上一版把它渲染成徽章，注释写的是「分类标签，不按值映射颜色」—— **那个判断是错的**：
 * A/B/C 确实是分级（源 tag 含 `core` → A）。但正因如此，它更不该显示：
 *
 * ```
 * 全库实测：prio=1 → 100% ["A"]（6767 = 全库词数）
 *           prio=2 → B 2433 / C 1488；prio=3 → B 558 / C 556
 * 源数据 tag：core(8458) / n(1561) / abstract(924) / v(610) / adj(433) /
 *             object(258) / person(234) / extension(228) / action(187) …
 * ```
 *
 * 源里 10+ 类**语义**标签（词性、抽象性、论元角色，且常多 tag 组合）导入时
 * 被压成**一个比特**：「含 `core` → A，否则 B/C」。所以：
 *
 * 1. `A` 与「第一个义项」**完全等价**（`prio=1` 恒为 `A`），是 `priority` 的函数；
 * 2. 屏上那个孤零零的 `A` 徽章不携带任何学习价值 —— 用户已经能从位置知道谁是主义项。
 *
 * 保留 `tags` 字段在数据里（`CoreSense` 仍接收它），只是不渲染；
 * 将来导入器若恢复语义标签，这里可以再放出真正的分类徽章。
 */

import type { CoreSense } from "@/domain/hulu-sprint";

/**
 * 义项类型以 **domain 为单一真源**（`src/domain/hulu-sprint.ts` 的 `CoreSense`）：
 * 页载荷契约（`huluPageWordItemResponseSchema`）与前端组件必须描述同一个 jsonb
 * 形状，各写一遍就会漂移。方向恒为 frontend → domain —— domain 层零出向依赖
 * （`.dependency-cruiser.cjs` 的 `domain-no-outbound`），反向 import 会被门禁拦下。
 *
 * 这里 re-export 保持既有调用点（`import { SenseList, type CoreSense } from
 * "@/frontend/components/words/SenseList"`）不变。
 */
export type { CoreSense };

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
        // 序号已按 priority 升序；这里只捕捉「实际权重 ≠ 位置」的异常。
        // 正常数据不会触发（实测 prio=1 恒为 A、顺序由 sortByPriority 保证）。
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
                {weightMismatch && (
                  <Badge tone="warm" className="shrink-0 px-1.5 py-0 text-[10px]">
                    权重 {d.priority}
                  </Badge>
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
