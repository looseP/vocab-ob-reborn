/**
 * AcousticAnchor —— 拼读声学胶囊（Phase 1 声学底座的共享 UI 壳）。
 *
 * 从 `ReviewCardView` 抽出，供**标准复习卡**与**新词初见编码卡**共用：
 * 两处都要「词形 / 音标 / 发音入口 / 口音开关」这一组控制，复制第二份必然漂移
 * （改了一处忘了另一处），且测试钩子（`acoustic-sticky-anchor` / `accent-toggle` /
 * `audio-waveform`）也应当只有一份契约。
 *
 * 组件本身**不持有播放状态**：所有状态与副作用由调用方的 `useAudioController`
 * 驱动，这里只做展示 + 事件上抛。
 */

import { Volume2 } from "lucide-react";
import type { Accent, AudioSource } from "@/frontend/reviewFlow/audioEngine";

/** 播放中的声波指示：纯 CSS（animate-pulse + 相位错开），不引入 JS 定时器。 */
export function SoundWave() {
  return (
    <span className="flex h-4 items-end gap-[2px]" data-testid="audio-waveform" aria-hidden>
      {[40, 90, 60].map((height, i) => (
        <span
          key={i}
          className="w-[2px] animate-pulse rounded-full bg-[var(--color-accent)]"
          style={{ height: `${height}%`, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * 拼读声学胶囊：**正反面通用容器顶部吸顶常驻** —— 无论翻到哪一面、
 * 无论卡背长内容滚到哪里，词形 / 音标 / 口音 / 发音入口始终在视线内。
 *
 * 吸顶偏移取顶栏高度（SiteHeader 的 `--header-height: 5rem` = `top-20`），
 * z-index 低于顶栏的 z-40，避免盖住导航。
 *
 * 放在翻面容器**外层**（兄弟节点）而非内部：翻面容器整体是 role=button，
 * 把按钮塞进去要额外处理事件冒泡与嵌套语义；做成兄弟节点后点击天然不触发翻转。
 */
export function AcousticStickyAnchor({
  lemma,
  ipa,
  accent,
  available,
  isPlaying,
  source,
  onPlayWord,
  onToggleAccent,
  hint = "R 拼读 · Shift+R 口音 · E 例句",
}: {
  lemma: string;
  ipa: string | null;
  accent: Accent;
  available: boolean;
  isPlaying: boolean;
  source: AudioSource | null;
  onPlayWord: () => void;
  onToggleAccent: () => void;
  /** 右下角快捷键提示。不同卡片可用的快捷键不同（如无例句时不提示 E），由调用方给。 */
  hint?: string;
}) {
  if (!lemma) return null;
  const wordPlaying = isPlaying && source === "word";
  return (
    <div
      className="sticky top-20 z-30 mb-3 flex w-full items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/95 px-3 py-1.5 text-left shadow-[var(--shadow-panel)] backdrop-blur-xl"
      data-testid="acoustic-sticky-anchor"
      data-no-flip
      onClick={(e) => e.stopPropagation()}
    >
      <span className="truncate text-sm font-semibold text-[var(--color-ink)]">{lemma}</span>
      {ipa && <span className="flex-none font-mono text-xs text-[var(--color-ink-soft)]">{ipa}</span>}
      {available && (
        <button
          type="button"
          data-no-flip
          onClick={(e) => {
            e.stopPropagation();
            onPlayWord();
          }}
          title="朗读发音（R）· 切换英音/美音（Shift+R）"
          aria-label="朗读发音 (R)"
          className="flex-none rounded-full p-1 text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          {wordPlaying ? <SoundWave /> : <Volume2 className="h-4 w-4" />}
        </button>
      )}
      {available && (
        <button
          type="button"
          data-no-flip
          data-testid="accent-toggle"
          onClick={(e) => {
            e.stopPropagation();
            onToggleAccent();
          }}
          title="切换口音（Shift+R）"
          aria-label={accent === "uk" ? "当前英音，切换到美音" : "当前美音，切换到英音"}
          className="flex-none rounded-full border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] tracking-wider transition-colors hover:border-[var(--color-accent)]"
        >
          <span className={accent === "uk" ? "font-bold text-[var(--color-accent)]" : "text-[var(--color-ink-soft)]"}>
            UK
          </span>
          <span className="px-0.5 text-[var(--color-ink-soft)]">/</span>
          <span className={accent === "us" ? "font-bold text-[var(--color-accent)]" : "text-[var(--color-ink-soft)]"}>
            US
          </span>
        </button>
      )}
      <span className="ml-auto hidden flex-none text-[10px] text-[var(--color-ink-soft)] sm:block">{hint}</span>
    </div>
  );
}
