/**
 * 每日捕获领域层测试：日文件投影的**确定性**与格式契约（设计定稿 §6）。
 *
 * 锁的不是"能渲染"，而是口径：
 *  - 同输入恒同输出（投影随时可重生成，不允许隐藏的随机/时变因素）；
 *  - 分节顺序 = 注册表 sort，空类型不出节，未知类型兜底"其他"节不丢数据；
 *  - `[#seq]` 稳定 ID / ⤳ [[slug]] 软引用 / 译句换行缩进 / 页脚统计。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_CAPTURE_TYPES,
  canTransitionEntryStatus,
  renderDailyCaptureFile,
  type DailyCaptureEntryRow,
  type DailyCaptureTypeRow,
} from "@/domain/daily-capture";

const USER = "u-1";

function makeType(key: string, label: string, sort: number): DailyCaptureTypeRow {
  return { user_id: USER, type_key: key, label, absorption_hint: null, sort, hidden: false, created_at: "2026-10-10T00:00:00Z" };
}

function makeEntry(overrides: Partial<DailyCaptureEntryRow>): DailyCaptureEntryRow {
  return {
    id: "e-x",
    user_id: USER,
    entry_date: "2026-10-10",
    seq: 1,
    entry_type: "phrase",
    content: "harness the power",
    meta: null,
    status: "raw",
    absorption: null,
    created_at: "2026-10-10T01:02:00Z",
    hidden_at: null,
    ...overrides,
  };
}

const TYPES = [makeType("phrase", "词组", 0), makeType("sentence", "例句", 1), makeType("method", "学习方法", 2)];
const CLOCK = (iso: string): string => new Date(iso).toISOString().slice(11, 16); // 测试注入的确定性时钟

describe("renderDailyCaptureFile（日文件投影）", () => {
  it("同输入恒同输出（确定性）", () => {
    const input = {
      date: "2026-10-10",
      types: TYPES,
      entries: [makeEntry({ seq: 1 }), makeEntry({ seq: 2, entry_type: "sentence", content: "She harnessed her frustration." })],
      formatClock: CLOCK,
    };
    expect(renderDailyCaptureFile(input)).toBe(renderDailyCaptureFile(input));
  });

  it("分节顺序 = 注册表 sort，空类型不出节，页脚统计口径钉住", () => {
    const markdown = renderDailyCaptureFile({
      date: "2026-10-10",
      types: TYPES,
      entries: [
        makeEntry({ seq: 2, entry_type: "sentence", content: "She harnessed her frustration." }),
        makeEntry({ seq: 1 }),
      ],
      formatClock: CLOCK,
    });
    expect(markdown).toContain("# 每日捕获 · 2026-10-10");
    expect(markdown.indexOf("## 词组 (1)")).toBeLessThan(markdown.indexOf("## 例句 (1)"));
    expect(markdown).not.toContain("## 学习方法");
    expect(markdown).toContain("- [#1] 01:02 harness the power");
    expect(markdown).toContain("- [#2] 01:02 She harnessed her frustration.");
    expect(markdown).toContain("---");
    expect(markdown).toContain("共 2 条 · 已回顾 0 · 已吸收 0");
  });

  it("meta 修饰：释义 / ⤳ [[词]] / 来源 / 译句换行缩进", () => {
    const markdown = renderDailyCaptureFile({
      date: "2026-10-10",
      types: TYPES,
      entries: [
        makeEntry({
          meta: {
            meaning: "利用…的力量",
            wordSlugs: ["harness"],
            sourceUrl: "https://example.com/a",
            translation: "她把挫败感转化成了有产出的事物。",
          },
          entry_type: "sentence",
          content: "She harnessed her frustration into something productive.",
        }),
      ],
      formatClock: CLOCK,
    });
    expect(markdown).toContain("— 利用…的力量 ⤳ [[harness]]（来源: https://example.com/a）");
    expect(markdown).toContain("  译：她把挫败感转化成了有产出的事物。");
  });

  it("未知类型兜底「其他」节，不丢数据；空日给占位行", () => {
    const orphanMarkdown = renderDailyCaptureFile({
      date: "2026-10-10",
      types: TYPES,
      entries: [makeEntry({ entry_type: "custom", content: "自定义类型的条目" })],
      formatClock: CLOCK,
    });
    expect(orphanMarkdown).toContain("## 其他 (1)");
    expect(orphanMarkdown).toContain("自定义类型的条目");

    const emptyMarkdown = renderDailyCaptureFile({ date: "2026-10-10", types: TYPES, entries: [], formatClock: CLOCK });
    expect(emptyMarkdown).toContain("（今日暂无条目）");
    expect(emptyMarkdown).toContain("共 0 条 · 已回顾 0 · 已吸收 0");
  });

  it("多行内容续行缩进两格，页脚计入回顾/吸收", () => {
    const markdown = renderDailyCaptureFile({
      date: "2026-10-10",
      types: TYPES,
      entries: [
        makeEntry({
          entry_type: "method",
          content: "词根 -spect- 全用\"看\"记：\ninspect 往里看 / retrospect 向后看",
          status: "reviewed",
        }),
      ],
      formatClock: CLOCK,
    });
    expect(markdown).toContain("inspect 往里看 / retrospect 向后看");
    expect(markdown).toContain("共 1 条 · 已回顾 1 · 已吸收 0");
  });

  it("置要加 ★ 前缀；类型行缺 label 时标题回退 type_key", () => {
    const marked = renderDailyCaptureFile({
      date: "2026-10-10",
      types: TYPES,
      entries: [makeEntry({ meta: { important: true } })],
      formatClock: CLOCK,
    });
    expect(marked).toContain("- [#1] 01:02 ★ harness the power");

    const noLabel = renderDailyCaptureFile({
      date: "2026-10-10",
      types: [{ ...makeType("custom", "", 9), label: undefined as unknown as string }],
      entries: [makeEntry({ entry_type: "custom", content: "自定义类型条目" })],
      formatClock: CLOCK,
    });
    expect(noLabel).toContain("## custom (1)");
  });

  it("seed 默认六类：sort 升序、note 兜底收尾", () => {
    expect(DEFAULT_DAILY_CAPTURE_TYPES.map((type) => type.typeKey)).toEqual([
      "phrase",
      "sentence",
      "method",
      "question",
      "idea",
      "note",
    ]);
  });
});

describe("canTransitionEntryStatus（M2 状态机）", () => {
  it("前向流转合法：raw→reviewed/archived，reviewed→absorbed/archived；同状态 = 幂等 no-op", () => {
    expect(canTransitionEntryStatus("raw", "reviewed")).toBe(true);
    expect(canTransitionEntryStatus("raw", "archived")).toBe(true);
    expect(canTransitionEntryStatus("reviewed", "absorbed")).toBe(true);
    expect(canTransitionEntryStatus("reviewed", "archived")).toBe(true);
    expect(canTransitionEntryStatus("raw", "raw")).toBe(true);
    expect(canTransitionEntryStatus("absorbed", "absorbed")).toBe(true);
    expect(canTransitionEntryStatus("archived", "archived")).toBe(true);
  });

  it("跳级与回退拒绝：raw→absorbed；终态 absorbed/archived 无出口", () => {
    expect(canTransitionEntryStatus("raw", "absorbed")).toBe(false);
    expect(canTransitionEntryStatus("reviewed", "raw")).toBe(false);
    expect(canTransitionEntryStatus("absorbed", "reviewed")).toBe(false);
    expect(canTransitionEntryStatus("absorbed", "archived")).toBe(false);
    expect(canTransitionEntryStatus("archived", "raw")).toBe(false);
    expect(canTransitionEntryStatus("archived", "absorbed")).toBe(false);
  });
});
