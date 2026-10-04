// src/frontend/components/review/L3ContextText.tsx
/**
 * L3 语境正文的**共享渲染件**（2026-10-04，FR-12 接线1 升级）。
 *
 * 为什么独立成文件：语境正文有**两个消费点**，此前只有卡背折叠一处、且直接渲染
 * 原文 ⇒ `〖45〗` 空号占位泄漏给用户（实测 `abundant`）。
 * 现在两处（卡背折叠 + 提示阶梯 H1′ 级）共用本组件，解析与展示口径只有一份。
 *
 * 两条渲染规则：
 * 1. `〖n〗` 是卷面数据编码，渲染为**空号角标**（解析在 `@/domain/l3-passage-text`，
 *    L1 侧没有"跳题"目标，故角标只作标识、不可点）；
 * 2. 目标词遮盖沿用 `MaskedPiece`（与正面例句线索同一实现），`masked` 时才遮。
 */
import { useState } from "react";
import { segmentPassageBlanks } from "@/domain/l3-passage-text";
import { MaskedPiece } from "@/frontend/components/words/ExamSplitText";

/** 卷面空号角标（非交互：复习卡上没有可跳的题）。 */
export function PassageBlankBadge({ blankNo }: { blankNo: number }) {
  return (
    <span
      data-testid="passage-blank-badge"
      title={`试卷第 ${blankNo} 空`}
      className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded px-1 align-middle text-[10px] font-semibold leading-none text-[var(--color-accent)]"
      style={{ background: "rgba(15, 111, 98, 0.08)" }}
    >
      {blankNo}
    </span>
  );
}

export function L3ContextText({
  text,
  maskTerm = null,
  masked = false,
  onUnmask,
}: {
  text: string;
  /** 遮盖锚（省略/为空则不遮盖）。 */
  maskTerm?: string | null;
  /** 初始是否遮盖目标词（提示级 = true；卡背折叠 = false）。 */
  masked?: boolean;
  onUnmask?: () => void;
}) {
  // 初始值语义即"是否遮盖"：同一卡片生命周期内 `masked` 不变（卡片切换由
  // ReviewPage 的 key 重挂载保证），故不需要同步 effect。
  const [revealed, setRevealed] = useState(!masked);
  return (
    <>
      {segmentPassageBlanks(text).map((segment, i) =>
        segment.kind === "blank" ? (
          <PassageBlankBadge key={`blank-${i}`} blankNo={segment.blankNo ?? 0} />
        ) : (
          <MaskedPiece
            key={`text-${i}`}
            text={segment.text}
            term={maskTerm}
            revealed={revealed}
            maskTitle="点击揭示词形"
            onUnmask={() => {
              setRevealed(true);
              onUnmask?.();
            }}
          />
        ),
      )}
    </>
  );
}
