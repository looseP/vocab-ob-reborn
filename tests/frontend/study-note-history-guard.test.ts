/**
 * Task 08 · 浏览器前进/后退 flush 屏障测试（先红后绿）。
 *
 * 最终语义（设计见台账 §1.6）：
 *  - 编辑器视图激活时压入「哨兵条目」（同 URL + marker），吸收第一次后退（同 URL、视觉原位）；
 *  - 后退跨步（哨兵 → 编辑条目）：触发 attemptLeave；成功 → 续行 go(-1) 离开；失败 → 停在原位；
 *  - 后退越过（连按直达他页）：先同步 cancelTo(editorUrl) 恢复编辑位置（并补 marker），再尝试；
 *  - attemptLeave 挂起期间：新 popstate 只做位置恢复，不重复发起；
 *  - 续行移动产生的 popstate 只消费一次（时间窗内），不吞掉后续真实后退。
 */
import { describe, expect, it } from "vitest";
import { StudyNoteHistoryGuard, STUDY_NOTES_GUARD_MARKER } from "@/frontend/state/studyNoteHistoryGuard";

const EDITOR_URL = "http://localhost/l3?section=study-notes&venue=cloze&noteId=N1";
const LIST_URL = "http://localhost/l3?section=study-notes&venue=cloze";
const HOME_URL = "http://localhost/";

type Entry = { state: Record<string, unknown> | null; url: string };

/** 数组式假历史栈：pushState 截断前向；go 越界为 no-op（不触发 popstate）。 */
class FakeHistory {
  entries: Entry[];
  index: number;
  private listeners: Array<() => void> = [];

  constructor(entries: Entry[], index?: number) {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.index = index ?? entries.length - 1;
  }

  getState(): Record<string, unknown> | null {
    return this.entries[this.index]?.state ?? null;
  }

  pushState(state: Record<string, unknown>, url: string): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ state, url });
    this.index = this.entries.length - 1;
  }

  getHref(): string {
    return this.entries[this.index]?.url ?? "";
  }

  back(): void {
    this.go(-1);
  }

  go(delta: number): void {
    const target = this.index + delta;
    if (target < 0 || target >= this.entries.length) return;
    this.index = target;
    for (const listener of [...this.listeners]) listener();
  }

  addPopStateListener(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }
}

/** 测试用 cancelTo：恢复编辑位置并补 marker（模拟真实 hook 的 navigate+replaceState）。 */
function markedCancel(history: FakeHistory): (url: string) => void {
  return (url) => {
    history.pushState({ ...(history.getState() ?? {}), [STUDY_NOTES_GUARD_MARKER]: true }, url);
  };
}

function setup(options: { synchronous?: boolean } = {}) {
  const history = new FakeHistory([
    { state: { idx: 0 }, url: HOME_URL },
    { state: { idx: 1 }, url: LIST_URL },
    { state: { idx: 2 }, url: EDITOR_URL },
  ]);
  const attempts: Array<() => void> = [];
  let resolveLast: (() => void) | null = null;
  const guard = new StudyNoteHistoryGuard(history, { cancelTo: markedCancel(history) });
  const cleanup = guard.activate(EDITOR_URL, (proceed) => {
    attempts.push(proceed);
    if (options.synchronous) {
      proceed();
      return undefined;
    }
    return new Promise<void>((resolve) => {
      resolveLast = resolve;
    });
  });
  return {
    history,
    guard,
    cleanup,
    attempts,
    /** 成功：执行 proceed（续行）并让 attemptLeave 承诺落定。 */
    succeed(): void {
      const proceed = attempts[attempts.length - 1]!;
      proceed();
      resolveLast?.();
      resolveLast = null;
    },
    /** 失败：不执行 proceed，仅让承诺落定（屏障内部已呈现错误）。 */
    async fail(): Promise<void> {
      resolveLast?.();
      resolveLast = null;
      // 让 guard 的 promise.then（pending 释放）落定
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("StudyNoteHistoryGuard · 激活", () => {
  it("激活时压入同 URL 哨兵条目（marker），位置不变", () => {
    const { history } = setup();
    expect(history.entries).toHaveLength(4);
    expect(history.entries[3]!.url).toBe(EDITOR_URL);
    expect(history.entries[3]!.state).toMatchObject({ [STUDY_NOTES_GUARD_MARKER]: true });
    expect(history.getHref()).toBe(EDITOR_URL);
  });

  it("当前条目已是哨兵（如前进回到它）：不重复压入", () => {
    const history = new FakeHistory([
      { state: null, url: LIST_URL },
      { state: { [STUDY_NOTES_GUARD_MARKER]: true }, url: EDITOR_URL },
    ]);
    const guard = new StudyNoteHistoryGuard(history, { cancelTo: markedCancel(history) });
    guard.activate(EDITOR_URL, () => {});
    expect(history.entries).toHaveLength(2);
  });

  it("激活时 URL 已不在编辑条目（迟到激活，如后退已落到列表）：不压哨兵、不截断前进栈", () => {
    const history = new FakeHistory(
      [
        { state: { idx: 0 }, url: LIST_URL },
        { state: { idx: 1 }, url: EDITOR_URL },
      ],
      0,
    );
    const guard = new StudyNoteHistoryGuard(history, { cancelTo: markedCancel(history) });
    guard.activate(EDITOR_URL, () => {});
    // 回归：旧实现会在此压入「列表 URL + marker」，浏览器语义下截断前进栈（len 2→1），
    // 使「后退到列表后再前进」无法回到笔记。
    expect(history.entries).toHaveLength(2);
    expect(history.getHref()).toBe(LIST_URL);
    expect(history.getState()).not.toMatchObject({ [STUDY_NOTES_GUARD_MARKER]: true });

    history.go(1); // 前进仍能回到编辑条目
    expect(history.getHref()).toBe(EDITOR_URL);
  });

  it("cleanup 后监听移除：后退不再触发 attemptLeave", () => {
    const { history, cleanup, attempts } = setup();
    cleanup();
    history.back();
    expect(attempts).toHaveLength(0);
  });
});

describe("StudyNoteHistoryGuard · 跨步（后退落在编辑条目）", () => {
  it("后退一步：触发 attemptLeave；视觉仍在原位；成功后续行一步离开", () => {
    const { history, attempts, succeed } = setup();
    history.back();
    expect(attempts).toHaveLength(1);
    expect(history.getHref()).toBe(EDITOR_URL);

    succeed();
    expect(history.getHref()).toBe(LIST_URL);
  });

  it("flush 失败：停在原位（编辑 URL）；再次后退可再次触发", async () => {
    const { history, attempts, fail } = setup();
    history.back();
    expect(attempts).toHaveLength(1);
    await fail();
    expect(history.getHref()).toBe(EDITOR_URL);

    history.back(); // 再按一次：越过 → 取消 + 再尝试
    expect(attempts).toHaveLength(2);
    expect(history.getHref()).toBe(EDITOR_URL);
  });
});

describe("StudyNoteHistoryGuard · 越过（连按后退直达列表）", () => {
  it("越过先取消恢复位置（补 marker），不重复发起；成功后续行落到列表", () => {
    const { history, attempts, succeed } = setup();
    history.back(); // → 编辑条目（attempt #1 挂起）
    history.back(); // → 列表（越过）
    expect(history.getHref()).toBe(EDITOR_URL); // 已恢复原位
    expect(history.getState()).toMatchObject({ [STUDY_NOTES_GUARD_MARKER]: true });
    expect(attempts).toHaveLength(1); // 挂起期间不重复发起

    succeed();
    expect(history.getHref()).toBe(LIST_URL);
  });

  it("越过且失败：停在原位；再按后退可重试（跨步）", async () => {
    const { history, attempts, fail } = setup();
    history.back();
    history.back();
    expect(history.getHref()).toBe(EDITOR_URL);
    await fail();
    expect(history.getHref()).toBe(EDITOR_URL);

    history.back(); // 第三次：跨步重试
    expect(attempts).toHaveLength(2);
    expect(history.getHref()).toBe(EDITOR_URL);
  });
});

describe("StudyNoteHistoryGuard · 续行 popstate 消费与哨兵落点", () => {
  it("续行 go(-1) 的 popstate 只消费一次；后续真实后退仍正常触发", () => {
    const { history, attempts, succeed } = setup();
    history.back();
    succeed(); // go(-1) → 列表；该 popstate 被消费（否则会触发取消 + 新尝试）
    expect(history.getHref()).toBe(LIST_URL);
    expect(attempts).toHaveLength(1);

    history.back(); // 真实后退（→ 首页）：仍触发新尝试（未被吞掉）
    expect(attempts).toHaveLength(2);
    expect(history.getHref()).toBe(EDITOR_URL); // 越过 → 取消恢复
  });

  it("前进落在哨兵条目：原位、不触发 attemptLeave", () => {
    const { history, attempts } = setup();
    history.back(); // → 编辑条目
    expect(attempts).toHaveLength(1);
    history.go(1); // 前进 → 哨兵
    expect(attempts).toHaveLength(1);
    expect(history.getHref()).toBe(EDITOR_URL);
  });
});

describe("StudyNoteHistoryGuard · attemptLeave 异常防护", () => {
  it("同步抛错：pending 释放，再次后退可再次触发", () => {
    const history = new FakeHistory([
      { state: null, url: LIST_URL },
      { state: { idx: 2 }, url: EDITOR_URL },
    ]);
    let calls = 0;
    const guard = new StudyNoteHistoryGuard(history, { cancelTo: markedCancel(history) });
    guard.activate(EDITOR_URL, () => {
      calls += 1;
      if (calls === 1) throw new Error("barrier exploded");
    });
    history.back();
    expect(calls).toBe(1);
    history.back();
    expect(calls).toBe(2);
  });
});
