/**
 * Task 09B · 卷面离开的双保存屏障合成（纯逻辑核心，可注入两侧屏障）。
 *
 * 问题：卷面（题纸）与侧栏（学习笔记）各有**独立**保存真源与独立屏障：
 *  - 题纸：`jumpBarrier`（`L3ExamPaper`）——`flushAnswers()` 成功返回 true，失败返回 false
 *    并经 toast 呈现（不抛）；
 *  - 笔记：`useStudyNoteEditor.requestNavigation`——**吞掉**失败写进 `navigationError`，
 *    既不 reject 也不返回布尔。
 *
 * 因此两侧的成功信号形态不同，且**都不能**靠 try/catch 判定笔记侧成败。本模块要求宿主把
 * 笔记侧包装成 `NoteBarrierOutcome`（显式 ok/reason），再由本模块负责：
 *  1) **顺序**：先笔记（附带面）后题纸（主面）；
 *  2) **短路**：首个失败即停——笔记失败时不再触发题纸 flush（不做无谓写，也不让后续失败
 *     掩盖真正的首个原因）；
 *  3) **归因**：回报 `failedBy`（note/sheet/navigation/busy），供 UI 给正确恢复指引
 *     （笔记冲突 ≠ 题纸未保存，恢复路径不同）；
 *  4) **绝不带出未确认内容**：任一失败都不执行 action。
 *
 * 重入：屏障挂起期间的重复请求被拒绝为 `busy`（双击/连点不得触发二次导航，也不得并发 flush）。
 *
 * 纪律：本模块不重实现任何保存判定（脏/冲突/IME 全由各自屏障负责），只负责合成与归因。
 */

/** 笔记侧屏障的显式结果：`requestNavigation` 吞错，必须由适配层回转成该形态。 */
export type NoteBarrierOutcome = { ok: true } | { ok: false; reason: string };

/** 笔记侧屏障：调用方传入**已执行 action** 的语义——成功才视为放行。 */
export type NoteLeaveBarrier = (action: () => void | Promise<void>) => Promise<NoteBarrierOutcome>;

/** 题纸侧屏障：沿用既有 `jumpBarrier` 形态（true=放行；false=拒答，已自行呈现）。 */
export type SheetLeaveBarrier = () => Promise<boolean>;

export type SheetLeaveFailure = "note" | "sheet" | "navigation" | "busy";

export interface SheetLeaveResult {
  ok: boolean;
  /** 失败来源；`ok: true` 时为 undefined。 */
  failedBy?: SheetLeaveFailure;
  /** 可读原因（笔记/导航失败时由对侧提供；题纸侧沿用既有文案，此处只做兜底说明）。 */
  reason?: string;
}

export interface ComposeSheetLeaveBarrierOptions {
  sheetBarrier: SheetLeaveBarrier;
  /** 侧栏未打开或未选中笔记时为 null——退化为纯题纸语义。 */
  noteBarrier: NoteLeaveBarrier | null;
}

export type ComposedSheetLeaveBarrier = (action: () => void | Promise<void>) => Promise<SheetLeaveResult>;

const SHEET_FAIL_REASON = "本卷作答尚未保存成功，暂不能离开本页。";
const BUSY_REASON = "正在保存，请稍候再试。";

/**
 * 合成「离开卷面」屏障。返回的函数签名与 `StudyNoteLeaveBarrier` 兼容
 * （`(action) => Promise<...>`，宿主可忽略返回值），但额外回报结构化结果供 UI 归因。
 */
export function composeSheetLeaveBarrier(
  options: ComposeSheetLeaveBarrierOptions,
): ComposedSheetLeaveBarrier {
  let inFlight = false;

  return async (action) => {
    if (inFlight) return { ok: false, failedBy: "busy", reason: BUSY_REASON };
    inFlight = true;
    try {
      // 1) 笔记（附带面）优先：失败即短路，不触发题纸 flush。
      const noteBarrier = options.noteBarrier;
      if (noteBarrier) {
        let outcome: NoteBarrierOutcome;
        try {
          // 用 no-op action：真实导航必须等到**两侧都**落定之后才执行，
          // 否则题纸侧仍可能拒答，而导航已经发生（不可回滚）。
          outcome = await noteBarrier(() => {});
        } catch (error) {
          // 适配层自身失手：保守拒答（不放行未确认内容）。
          return {
            ok: false,
            failedBy: "note",
            reason: error instanceof Error ? error.message : "笔记保存未完成，无法离开。",
          };
        }
        if (!outcome.ok) {
          return { ok: false, failedBy: "note", reason: outcome.reason };
        }
      }

      // 2) 题纸（主面）：既有语义——false 表示已拒答并自行呈现。
      let sheetOk = false;
      try {
        sheetOk = await options.sheetBarrier();
      } catch {
        return { ok: false, failedBy: "sheet", reason: SHEET_FAIL_REASON };
      }
      if (!sheetOk) return { ok: false, failedBy: "sheet", reason: SHEET_FAIL_REASON };

      // 3) 两侧均落定：执行真实导航。
      try {
        await action();
      } catch (error) {
        return {
          ok: false,
          failedBy: "navigation",
          reason: error instanceof Error ? error.message : "导航失败。",
        };
      }
      return { ok: true };
    } finally {
      inFlight = false;
    }
  };
}
