// @vitest-environment jsdom

/**
 * 划词取文（2026-09-29）。
 *
 * 这是整个功能里最容易出错、也最难靠肉眼验证的一层：它要在 DOM 文本流里算偏移。
 * 算错了后果很隐蔽 —— 译文变成隔壁句子的，或扩展到错误的句子。
 *
 * ## 重点覆盖的不变量
 *
 * 1. **输入框里的选区不翻** —— 在 textarea 里划词是复制，不是阅读意图。
 * 2. **纯符号/空白不翻** —— 拖过一行标点不该触发一次网络请求。
 * 3. **短选区扩到整句** —— 单词丢给翻译端点多半译不出人话（`abandon` 的义项
 *    取决于句子）；这是「扫一眼就懂」的关键。
 * 4. **超长选区收口到首句** —— 整段硬翻会被服务端 400 拒掉，界面上等于没反应。
 * 5. **展开后仍显示用户选中的原文** —— 否则会困惑「我明明选的是这个词」。
 *
 * ## jsdom 的限制
 *
 * jsdom 的 `Range.getBoundingClientRect()` 恒返回 0，**位置断言在这里无意义**
 * （真机验证过，见 handoff §实测）。这里只断言**文本取到什么**，位置留给真机。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { extractProseSelection, MAX_TRANSLATE_CHARS } from "@/frontend/utils/selectionProse";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** 在指定文本节点上建立选区。 */
function selectText(target: Node, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(target, start);
  range.setEnd(target, end);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function firstText(selector: string): Text | null {
  return document.querySelector(selector)?.firstChild as Text | null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("排除：不该翻的选区", () => {
  it("无选区 / 折叠选区 → null", () => {
    mount("<p>Some text here.</p>");
    expect(extractProseSelection()).toBeNull();
  });

  it("textarea 里的选区 → null（在框里划词是复制）", () => {
    mount("<textarea>hello world</textarea>");
    const ta = document.querySelector("textarea")!.firstChild as Text;
    selectText(ta, 0, 5);
    expect(extractProseSelection()).toBeNull();
  });

  it("input 里的选区 → null", () => {
    mount("<div><input value='hello' /></div>");
    // input 的 value 不是文本节点，无法建 Range；这里直接断言无节点可选
    expect(extractProseSelection()).toBeNull();
  });

  it("[data-no-translate] 内的选区 → null（组件自留标记）", () => {
    mount('<p data-no-translate>Some text here.</p>');
    selectText(firstText("p")!, 0, 4);
    expect(extractProseSelection()).toBeNull();
  });

  it("[data-selection-translate] 自身内的选区 → null（浮层不触发自己）", () => {
    mount('<div data-selection-translate><p>译文文字</p></div>');
    selectText(firstText("p")!, 0, 2);
    expect(extractProseSelection()).toBeNull();
  });

  it("纯符号/空白 → null（拖过一排标点不该发请求）", () => {
    mount("<p>--- ... !!! ???</p>");
    selectText(firstText("p")!, 0, 15);
    expect(extractProseSelection()).toBeNull();
  });

  it("空白选区 → null", () => {
    mount("<p>Some text here.</p>");
    selectText(firstText("p")!, 0, 4);
    // 把选区缩到全空白
    const node = firstText("p")!;
    document.body.innerHTML = "<p>     </p>";
    selectText(firstText("p")!, 1, 4);
    expect(extractProseSelection()).toBeNull();
    void node;
  });
});

describe("短选区 → 扩到整句", () => {
  it("选一个词 → 译文文本是所在整句", () => {
    mount("<p>Rescuers eventually had to abandon their mission.</p>");
    const node = firstText("p")!;
    const start = node.textContent!.indexOf("abandon");
    selectText(node, start, start + "abandon".length);

    const found = extractProseSelection();
    expect(found).not.toBeNull();
    expect(found!.text).toBe("Rescuers eventually had to abandon their mission.");
    expect(found!.expanded).toBe(true);
  });

  it("扩展后仍回显用户实际选中的片段（否则会困惑）", () => {
    mount("<p>Rescuers eventually had to abandon their mission.</p>");
    const node = firstText("p")!;
    const start = node.textContent!.indexOf("abandon");
    selectText(node, start, start + "abandon".length);

    const found = extractProseSelection();
    expect(found!.selectedText).toBe("abandon");
    expect(found!.text).not.toBe(found!.selectedText);
  });

  it("段落有多句时，扩展到的是**包含选区的那句**而非整段", () => {
    mount("<p>First sentence here. The court ruled that the defendant had violated the terms. Third one.</p>");
    const node = firstText("p")!;
    const start = node.textContent!.indexOf("ruled");
    selectText(node, start, start + "ruled".length);

    const found = extractProseSelection();
    expect(found!.text).toBe("The court ruled that the defendant had violated the terms.");
    expect(found!.text).not.toContain("First sentence here.");
  });

  it("选区已经对齐句子边界 → 不扩展（原样送去翻译）", () => {
    const sentence = "Rescuers eventually had to abandon their mission.";
    mount(`<p>${sentence} Another sentence follows here.</p>`);
    const node = firstText("p")!;
    selectText(node, 0, sentence.length);

    const found = extractProseSelection();
    expect(found!.expanded).toBe(false);
    expect(found!.text).toBe(sentence);
  });

  /**
   * 回归锁（2026-09-29 真机截图）：用户选的是**长句的后半截**。
   * 早期版本按「选区 < 12 字才扩句」处理，34 ≥ 12 于是不扩，译文成了
   * 「但异常水平是一个问题」—— 「但」悬空，因为前半句没翻。
   * 正确判据是**有没有对齐句子边界**，与长度无关。
   */
  it("长选区但从句子中间开始 → 仍扩到整句（不看长度，只看边界）", () => {
    const full = "Some fat is normal in the liver, but abnormal levels are a concern.";
    mount(`<p>${full}</p>`);
    const node = firstText("p")!;
    const tail = "but abnormal levels are a concern.";
    const start = node.textContent!.indexOf(tail);
    selectText(node, start, start + tail.length);

    const found = extractProseSelection();
    expect(found!.selectedText).toBe(tail);
    expect(found!.text).toBe(full);
    expect(found!.expanded).toBe(true);
  });

  it("长选区但止于句子中间 → 仍扩到整句", () => {
    const full = "Some fat is normal in the liver, but abnormal levels are a concern.";
    mount(`<p>${full}</p>`);
    const node = firstText("p")!;
    const head = "Some fat is normal in the liver,";
    selectText(node, 0, head.length);

    const found = extractProseSelection();
    expect(found!.text).toBe(full);
    expect(found!.expanded).toBe(true);
  });

  it("跨多句选区 → 取首句到末句的全段（findSentenceRange 的兜底路径）", () => {
    const first = "First sentence here.";
    const second = "The court ruled that the defendant had violated the terms.";
    mount(`<p>${first} ${second}</p>`);
    const node = firstText("p")!;
    selectText(node, 0, node.textContent!.length);

    const found = extractProseSelection();
    expect(found!.text).toBe(`${first} ${second}`);
  });
});

describe("长选区 → 收口到首句", () => {
  it("超长选区不硬翻（会被服务端 400 拒掉），只取首句且不超上限", () => {
    const long = Array.from({ length: 400 }, (_, i) => `sentence ${i} here.`).join(" ");
    mount(`<p>${long}</p>`);
    const node = firstText("p")!;
    selectText(node, 0, node.textContent!.length);

    const found = extractProseSelection();
    expect(found).not.toBeNull();
    expect(found!.text.length).toBeLessThanOrEqual(MAX_TRANSLATE_CHARS);
    expect(found!.text.startsWith("sentence 0 here.")).toBe(true);
  });
});

describe("中文与其他排版", () => {
  it("中文短句内的词 → 扩到整句", () => {
    mount("<p>救援人员最终不得不放弃他们的任务。</p>");
    const node = firstText("p")!;
    const start = node.textContent!.indexOf("放弃");
    selectText(node, start, start + 2);

    const found = extractProseSelection();
    expect(found!.text).toBe("救援人员最终不得不放弃他们的任务。");
  });

  it("列表项 / 引用块里的词同样能扩句", () => {
    mount("<ul><li>The court ruled that the defendant had violated the terms.</li></ul>");
    const node = firstText("li")!;
    const start = node.textContent!.indexOf("court");
    selectText(node, start, start + 5);

    const found = extractProseSelection();
    expect(found!.text).toBe("The court ruled that the defendant had violated the terms.");
  });
});
