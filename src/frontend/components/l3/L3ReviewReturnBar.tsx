// src/frontend/components/l3/L3ReviewReturnBar.tsx
/**
 * L3 侧的回程条（FR-12 接线1，2026-10-04）。
 *
 * 只在**由复习卡语境深链进入**时出现（判定见 `viewModels/reviewReturnNavigation`）。
 * 文案要说清两件事：为什么在这里、回去会发生什么（原卡位置会复原）——
 * 否则用户会以为"返回复习"等于重开一轮。
 */
import { Button } from "@/frontend/components/ui/Button";

export function L3ReviewReturnBar({ onBack }: { onBack: () => void }) {
  return (
    <div
      data-testid="l3-back-to-review"
      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-accent-soft)] px-3 py-2"
    >
      <p className="text-[12px] text-[var(--color-ink-soft)]">
        从复习卡进来 · 看完可以直接回去接着复习（原卡位置会复原）
      </p>
      <Button size="sm" variant="secondary" onClick={onBack}>
        ← 返回复习
      </Button>
    </div>
  );
}
