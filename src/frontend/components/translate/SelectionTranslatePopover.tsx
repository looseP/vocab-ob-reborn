/**
 * 划词译文浮层（2026-09-29）。
 *
 * 贴在选区旁边，不跳页、不进侧栏 —— 用户的眼睛本来就在那一行上。
 * 刻意做成**读久了一眼能扫完**的样子：原文一行（截断）、译文若干行，无多余控件。
 *
 * 定位策略：优先落在选区下方；下方空间不够就翻到上方；左右则夹在视口内。
 * 用 fixed + 视口坐标，是因为 `extractProseSelection` 给的 `rect` 就是视口坐标。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { translateText, type TranslateTextOutcome } from "@/frontend/api/translate";
import { clearOne } from "@/frontend/utils/translationCache";

export interface SelectionTranslateState {
  /** 待译文本（可能已扩展到整句）。 */
  text: string;
  /** 用户实际选中的片段。 */
  selectedText: string;
  /** 是否扩到了整句 —— 决定标题写「整句」还是「选区」。 */
  expanded: boolean;
  /** 选区视口坐标。 */
  rect: { top: number; bottom: number; left: number; right: number };
}

const PANEL_WIDTH = 340;
const VIEWPORT_MARGIN = 12;
const GAP = 8;
/** 视口高度低于此值就不做「下方/上方」判断，直接贴下方（避免抖动）。 */
const MIN_VIEWPORT_HEIGHT_FOR_FLIP = 240;

/**
 * 把浮层摆到选区旁边，**并保证它落在视口内**。
 *
 * 「保证落在视口内」是硬要求，不是优化。2026-09-29 真机实测抓到过一个反例：
 * 视口高 651、选区在 y=1736（页面下方、视口外）时，「优先下方、否则翻到上方」
 * 算出的两个位置**都在屏幕外** —— 浮层渲染了但用户看不见，等于没有。
 * 所以最后一步无条件把 top/left 夹进视口；夹完之后浮层可能不再紧贴选区，
 * 但「能看见」远比「贴着」重要。
 */
function computePosition(rect: { top: number; bottom: number; left: number; right: number }, panelHeight: number) {
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  const below = rect.bottom + GAP;
  const fitsBelow = viewportH - below >= panelHeight + VIEWPORT_MARGIN;
  const aboveFits = viewportH >= MIN_VIEWPORT_HEIGHT_FOR_FLIP
    && rect.top - GAP - panelHeight >= VIEWPORT_MARGIN;
  // 下方放得下就下方；放不下且上方放得下就翻上去；两边都不行时取下方（随后被夹住）
  const preferred = fitsBelow ? below : aboveFits ? rect.top - GAP - panelHeight : below;

  // 无条件夹进视口：这是「浮层必须可见」这条不变量的执行点。
  const top = Math.min(
    Math.max(VIEWPORT_MARGIN, preferred),
    Math.max(VIEWPORT_MARGIN, viewportH - panelHeight - VIEWPORT_MARGIN),
  );

  // 水平：以选区中点对齐，但夹进视口（选区在右边缘时不越界）
  const centerX = (rect.left + rect.right) / 2;
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, centerX - PANEL_WIDTH / 2),
    Math.max(VIEWPORT_MARGIN, viewportW - PANEL_WIDTH - VIEWPORT_MARGIN),
  );

  return { top, left, maxHeight: Math.max(160, viewportH - top - VIEWPORT_MARGIN) };
}

export function SelectionTranslatePopover({
  state,
  targetLang,
  onClose,
}: {
  state: SelectionTranslateState;
  targetLang: string;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<TranslateTextOutcome | null>(null);
  const [loading, setLoading] = useState(true);
  const [position, setPosition] = useState(() => computePosition(state.rect, 160));
  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * 请求序号：连续划词时先发的请求可能后到。序号小的结果直接丢弃，
   * 否则会出现「上一段的译文盖在新选区上」。
   */
  const seq = useRef(0);

  /**
   * 翻译范围口径（2026-10-04 用户反馈修正）：**引什么翻什么**。
   *
   * 此前翻的是 `state.text`（`extractProseSelection` 兜底扩成的整句），
   * 而引用区显示的却是 `state.selectedText` —— 用户选一个词组、拿到一整句译文，
   * 「我选的是这个、你翻的是那个」正是这种不一致的体感。
   * 现在默认翻**选区原文**；扩句能力保留，降级为页脚的显式入口「翻整句」。
   */
  const [scope, setScope] = useState<"selection" | "sentence">(() =>
    state.selectedText.trim() ? "selection" : "sentence",
  );
  // 送去翻译的文本：选区口径用 selectedText（空白选区不可用，退回扩句文本兜底）
  const scopeText =
    scope === "selection" && state.selectedText.trim() ? state.selectedText : state.text;

  const run = useCallback(
    async (text: string, bypassCache: boolean) => {
      seq.current += 1;
      const my = seq.current;
      setLoading(true);
      setOutcome(null);
      // 必须**先删缓存再请求**：读缓存是同步的，先请求的话这次仍拿到旧译文，
      // 界面会像「重新翻译没生效」。
      if (bypassCache) clearOne(text, targetLang);
      const res = await translateText(text, targetLang);
      if (my === seq.current) {
        setOutcome(res);
        setLoading(false);
      }
    },
    [targetLang],
  );

  useEffect(() => {
    void run(scopeText, false);
  }, [run, scopeText]);

  // 量出实际高度后再校正位置（首帧只能按估算值，否则长译文会被视口截断）
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPosition(computePosition(state.rect, el.getBoundingClientRect().height));
  }, [state.rect, outcome, loading]);

  // 点别处收起（点在浮层自身不算），Esc 收起
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-selection-translate]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      data-selection-translate
      data-testid="selection-translate-popover"
      role="dialog"
      aria-label="选区译文"
      style={{ top: position.top, left: position.left, width: PANEL_WIDTH, maxHeight: position.maxHeight }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] shadow-xl"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface,var(--color-bg))] px-3 py-1.5">
        <span className="text-[11px] font-medium text-[var(--color-ink-soft)]">
          {scope === "sentence" ? "整句译文" : "选区译文"}
        </span>
        <div className="flex items-center gap-1.5">
          {outcome?.fromCache && <span className="text-[10px] text-[var(--color-ink-soft)]">缓存</span>}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭译文"
            className="text-[11px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
          >
            关闭
          </button>
        </div>
      </div>

      <div className="overflow-y-auto bg-[var(--color-surface,var(--color-bg))] px-3 py-2">
        <p className="border-l-2 border-[var(--color-border)] pl-2 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
          {state.selectedText.length > 160 ? `${state.selectedText.slice(0, 160)}…` : state.selectedText}
        </p>

        {loading ? (
          <p className="mt-1.5 pl-2 text-[12px] text-[var(--color-ink-soft)]">翻译中…</p>
        ) : outcome && outcome.translation ? (
          <p className="mt-1.5 border-l-2 border-[var(--color-accent)] pl-2 text-[13px] leading-relaxed text-[var(--color-ink)]">
            {outcome.translation}
          </p>
        ) : (
          <p className="mt-1.5 pl-2 text-[12px] text-[var(--color-ink-soft)]">
            暂不可用{outcome?.warning ? `（${outcome.warning}）` : ""}
          </p>
        )}
      </div>

      {!loading && (
            <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface,var(--color-bg))] px-3 py-1.5">
              {/*
                这里**刻意不显示 provider id**（2026-09-29 修正）。
                早期版本在页脚露出裸的 `mymemory` / `google-web`，结果被用户当成
                「请求发到别处去了」—— provider 是**上游翻译源**，跟请求打到哪个
                端点无关，裸 id 长得就像个地址，纯误导。诊断信息归日志，不归界面。
              */}
              {/*
                扩句入口（2026-10-04）：只有**真的发生过扩句**才出现 —— 选区本来
                就是完整句时给这个按钮毫无意义。默认只译选区，需要更大语境时再点。
              */}
              {state.expanded && state.selectedText.trim() && (
                <button
                  type="button"
                  data-testid="selection-scope-toggle"
                  onClick={() => setScope((s) => (s === "selection" ? "sentence" : "selection"))}
                  className="text-[10px] text-[var(--color-ink-soft)] underline-offset-2 transition-colors hover:text-[var(--color-accent)] hover:underline"
                >
                  {scope === "selection" ? "翻整句" : "只译选区"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void run(scopeText, true)}
                className="text-[10px] text-[var(--color-ink-soft)] underline-offset-2 transition-colors hover:text-[var(--color-accent)] hover:underline"
              >
                重新翻译
              </button>
            </div>
      )}
    </div>
  );
}
