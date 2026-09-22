/**
 * 学习笔记浏览器前进/后退 flush 屏障（Task 08）——纯逻辑核心（可注入历史适配器）。
 *
 * 目标：编辑中的笔记在浏览器后退/前进时先走 flush（复用 controller 的 requestNavigation
 * 语义），成功才真正离开；失败留在原位并保留本地编辑（由屏障呈现错误）。
 *
 * 机制（详见执行台账 §1.6）：
 *  - 编辑器视图激活时在当前 URL 上压入「哨兵条目」（同 URL + marker），吸收第一次后退
 *    （同 URL、视觉原位）；
 *  - popstate 落在哨兵条目：原位（无操作）；
 *  - popstate 落在编辑条目（跨步）：触发 attemptLeave；成功 → continueLeave（go(-1) 一步离开）；
 *    失败 → 停在此处（本地输入未动）；
 *  - popstate 越过编辑条目（快速连按/直达他页）：先 cancelTo(编辑 URL) 同步恢复位置
 *    （真实 hook 用路由感知的 push + 补 marker，保证 React Router 与 URL 一致），
 *    再触发 attemptLeave；
 *  - attemptLeave 挂起期间的新 popstate：只做位置恢复，不重复发起；
 *  - continueLeave 产生的 popstate 只消费一次（时间窗内），不吞掉后续真实后退。
 *
 * 纪律：不假设 attemptLeave 一定成功（失败时不续行）；不依赖卸载时发送请求保全内容。
 */
export const STUDY_NOTES_GUARD_MARKER = "__n1StudyNotesGuard";

/** 续行移动后等待自身 popstate 的消费窗口（超过此窗口视为真实用户导航）。 */
const LEAVING_CONSUME_WINDOW_MS = 1500;

export interface StudyNoteHistoryAdapter {
  getState(): Record<string, unknown> | null;
  pushState(state: Record<string, unknown>, url: string): void;
  getHref(): string;
  go(delta: number): void;
  addPopStateListener(listener: () => void): () => void;
}

export interface StudyNoteHistoryGuardOptions {
  /** 越过编辑条目时的同步取消动作（恢复编辑位置）。缺省为 raw pushState + marker。 */
  cancelTo?: (editorUrl: string) => void;
  now?: () => number;
}

function normalizeHref(href: string): string {
  try {
    const url = new URL(href, "http://localhost");
    return `${url.pathname}${url.search}`;
  } catch {
    return href;
  }
}

export class StudyNoteHistoryGuard {
  private readonly adapter: StudyNoteHistoryAdapter;
  private readonly options: StudyNoteHistoryGuardOptions;

  private editorUrl: string | null = null;
  private attemptLeave: ((proceed: () => void) => void | Promise<void>) | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending = false;
  private leaving = false;
  private leavingAt = 0;

  constructor(adapter: StudyNoteHistoryAdapter, options: StudyNoteHistoryGuardOptions = {}) {
    this.adapter = adapter;
    this.options = options;
  }

  /** 激活（编辑器视图挂载 / noteId 变化）。返回清理函数（移除 popstate 监听）。 */
  activate(editorUrl: string, attemptLeave: (proceed: () => void) => void | Promise<void>): () => void {
    this.unsubscribe?.();
    this.editorUrl = editorUrl;
    this.attemptLeave = attemptLeave;
    this.pending = false;
    this.leaving = false;

    // 不变量：只在「确实停留在编辑 URL」时才吸收一次后退。
    // 若调用方在 URL 已离开编辑视图（如后退到列表）时迟到激活，压入哨兵会把列表 URL
    // 写成新条目并**截断前进栈**（浏览器语义），导致「后退再前进」无法回到笔记。
    if (!this.isOnGuardEntry() && this.sameUrl(this.adapter.getHref(), editorUrl)) {
      const state = this.adapter.getState();
      this.adapter.pushState({ ...(state ?? {}), [STUDY_NOTES_GUARD_MARKER]: true }, this.adapter.getHref());
    }

    const listener = (): void => this.handlePop();
    this.unsubscribe = this.adapter.addPopStateListener(listener);
    return () => {
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    };
  }

  private isOnGuardEntry(): boolean {
    const state = this.adapter.getState();
    return Boolean(state && state[STUDY_NOTES_GUARD_MARKER] === true);
  }

  private sameUrl(a: string, b: string): boolean {
    return normalizeHref(a) === normalizeHref(b);
  }

  private handlePop(): void {
    // 续行移动（continueLeave）产生的 popstate：消费一次
    if (this.leaving) {
      const elapsed = (this.options.now ?? Date.now)() - this.leavingAt;
      this.leaving = false;
      if (elapsed <= LEAVING_CONSUME_WINDOW_MS) return;
    }

    if (this.editorUrl === null) return;
    if (this.isOnGuardEntry()) return; // 落在哨兵条目：原位

    const href = this.adapter.getHref();
    if (this.sameUrl(href, this.editorUrl)) {
      this.startAttempt(); // 跨步：离开尝试
      return;
    }

    // 越过编辑条目：先同步恢复编辑位置（路由感知），再尝试离开
    this.cancel(href);
    this.startAttempt();
  }

  private cancel(targetHref: string): void {
    const url = this.editorUrl ?? targetHref;
    if (this.options.cancelTo) {
      this.options.cancelTo(url);
      return;
    }
    const state = this.adapter.getState();
    this.adapter.pushState({ ...(state ?? {}), [STUDY_NOTES_GUARD_MARKER]: true }, url);
  }

  private startAttempt(): void {
    if (this.pending || this.attemptLeave === null) return;
    this.pending = true;

    let proceeded = false;
    const proceed = (): void => {
      if (proceeded) return;
      proceeded = true;
      this.pending = false;
      this.continueLeave();
    };

    try {
      const handle = this.attemptLeave(proceed);
      if (handle && typeof (handle as Promise<void>).then === "function") {
        (handle as Promise<void>).then(
          () => {
            if (!proceeded) this.pending = false; // 屏障失败（未续行）：释放，等待下次尝试
          },
          () => {
            this.pending = false;
          },
        );
      }
    } catch {
      this.pending = false; // 同步异常：释放，等待下次尝试
    }
  }

  /** 离开续行：从当前编辑位置向「编辑条目之前」走一步。 */
  private continueLeave(): void {
    this.leaving = true;
    this.leavingAt = (this.options.now ?? Date.now)();
    this.adapter.go(-1);
  }
}
