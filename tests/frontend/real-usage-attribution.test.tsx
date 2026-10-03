/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 「真实语料佐证」署名渲染测试 —— **许可证义务的履行证据**。
 *
 * 这些断言必须落在**用户可见文本**上，而不是"调用了某个解析函数"：
 * 合规要求的是"作者名出现在页面上"，不是"代码里有个函数能拿到作者名"。
 * （本仓已有此纪律：`review-card-audio.test.tsx` 靠打桩 `useAudioController`
 * 只能验到"函数被调用"，真机 TTS 参数才验得到。）
 *
 * 五种情形（任务口径）：
 * 1. CC BY 2.0 FR 一条 → 作者名 + 许可名 + 许可链接 + 句子页链接都在
 * 2. CC0 1.0 一条 → 给出处但**不写"需署名"**（公有领域奉献）
 * 3. real_usage 缺失 → 整块不渲染（不留空壳）
 * 4. author 缺失 → 显式写「待补」，**不静默省略**（静默省略 = 看起来已署名）
 * 5. real_usage 类型错误 → 不抛错、整块不渲染
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ExampleLayerBlock } from "@/frontend/components/review/WordCardExamLayers";
import { parseRealUsageFromExample } from "@/domain/word-exam";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
});

function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted.push({ root, container });
  return container;
}

const TEXT = "The meteorological conditions have worsened.";
const TERM = "meteorological";

const base = {
  text: TEXT,
  translation: null,
  term: TERM,
  source: null,
  sourceType: null,
  url: null,
  modified: false,
  verifiedCount: 0,
};

/** 真实形状（库里 meteorological 一条，含 2026-10-03 回补的 author）。 */
const CC_BY_USAGE = {
  text: "The meteorological conditions have worsened.",
  author: "anzart",
  license: "CC BY 2.0 FR",
  url: "https://tatoeba.org/en/sentences/show/12673299",
  source_type: "tatoeba",
  source: "Tatoeba 真实语料（CC BY 2.0 FR）",
  has_official_zh: false,
};

/** 真实形状（库里 rid 一条）。 */
const CC0_USAGE = {
  text: "Get rid of it.",
  author: "ddnktr",
  license: "CC0 1.0",
  url: "https://tatoeba.org/en/sentences/show/10143796",
  source_type: "tatoeba",
  source: "Tatoeba 真实语料（CC0 1.0）",
  has_official_zh: false,
};

const realUsageOf = (items: unknown) => parseRealUsageFromExample({ verified: { real_usage: items } });

describe("ExampleLayerBlock · 真实语料佐证署名", () => {
  it("情形 1：CC BY 2.0 FR —— 作者名、许可名、许可链接、句子页链接全部出现在渲染结果里", () => {
    const c = mount(
      createElement(ExampleLayerBlock, { ...base, realUsage: realUsageOf([CC_BY_USAGE]) }),
    );
    const block = c.querySelector('[data-testid="real-usage"]');
    expect(block, "署名区块应渲染").toBeTruthy();

    const text = block!.textContent ?? "";
    // 作者名（§4.2 的核心要求）——必须真的显示出来
    expect(text).toContain("作者");
    expect(text).toContain("anzart");
    // 许可名与出处
    expect(text).toContain("CC BY 2.0 FR");
    expect(text).toContain("Tatoeba");
    // 佐证句原文
    expect(text).toContain("The meteorological conditions have worsened.");

    // 许可 URI（§4.1「附上本许可的副本或 URI」）
    const links = [...block!.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("https://creativecommons.org/licenses/by/2.0/fr/");
    // 句子 permalink
    expect(links).toContain("https://tatoeba.org/en/sentences/show/12673299");
  });

  it("情形 1b：署名链接不弱于同屏其它链接（都带下划线 + 可点击，§4.2 显著性要求）", () => {
    const c = mount(
      createElement(ExampleLayerBlock, {
        ...base,
        url: "https://example.com/src",
        realUsage: realUsageOf([CC_BY_USAGE]),
      }),
    );
    const block = c.querySelector('[data-testid="real-usage"]')!;
    const licenseLink = [...block.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === "https://creativecommons.org/licenses/by/2.0/fr/",
    ) as HTMLAnchorElement;
    expect(licenseLink).toBeTruthy();
    // 与 .ex-layer 里既有「原文」链接同款：underline + 新窗口打开
    expect(licenseLink.className).toContain("underline");
    expect(licenseLink.getAttribute("target")).toBe("_blank");
    expect(licenseLink.getAttribute("rel")).toContain("noreferrer");
  });

  it("情形 2：CC0 1.0 —— 给出处但不写「需署名」字样", () => {
    const c = mount(
      createElement(ExampleLayerBlock, { ...base, realUsage: realUsageOf([CC0_USAGE]) }),
    );
    const text = c.querySelector('[data-testid="real-usage"]')!.textContent ?? "";
    // 出处照常给
    expect(text).toContain("ddnktr");
    expect(text).toContain("CC0 1.0");
    expect(text).toContain("Tatoeba");
    // 标签是「出处」而非「作者」（CC0 无署名义务）
    expect(text).toContain("出处");
    // 且不出现任何"待补/需署名"的暗示
    expect(text).not.toContain("待补");
  });

  it("情形 3：real_usage 缺失 —— 署名区块整块不渲染，其余内容照常", () => {
    const c = mount(createElement(ExampleLayerBlock, { ...base, realUsage: [] }));
    const layer = c.querySelector('[data-testid="ex-layer"]')!;
    expect(layer.textContent).toContain(TEXT);
    expect(c.querySelector('[data-testid="real-usage"]')).toBeNull();
    expect(layer.textContent).not.toContain("真实语料佐证");
  });

  it("情形 4：author 缺失 —— 显式写「待补」，句子与许可仍在（不静默省略）", () => {
    const { author: _omitted, ...withoutAuthor } = CC_BY_USAGE;
    const c = mount(
      createElement(ExampleLayerBlock, { ...base, realUsage: realUsageOf([withoutAuthor]) }),
    );
    const text = c.querySelector('[data-testid="real-usage"]')!.textContent ?? "";
    // 句子与许可仍在 —— 署名不全不代表出处可以不写
    expect(text).toContain("The meteorological conditions have worsened.");
    expect(text).toContain("CC BY 2.0 FR");
    // 但署名必须**显式**说明未补，不能看起来像已署名
    expect(text).toContain("待补");
  });

  it("情形 5：real_usage 类型错误 —— 不抛错，且署名区块不渲染", () => {
    expect(() =>
      mount(
        createElement(ExampleLayerBlock, {
          ...base,
          realUsage: parseRealUsageFromExample({ verified: { real_usage: "nope" } }),
        }),
      ),
    ).not.toThrow();
    const c = mount(
      createElement(ExampleLayerBlock, {
        ...base,
        realUsage: parseRealUsageFromExample({ verified: { real_usage: { not: "an array" } } }),
      }),
    );
    expect(c.querySelector('[data-testid="ex-layer"]')).toBeTruthy();
    expect(c.querySelector('[data-testid="real-usage"]')).toBeNull();
  });

  it("多条佐证按序全部渲染", () => {
    const c = mount(
      createElement(ExampleLayerBlock, {
        ...base,
        realUsage: realUsageOf([CC_BY_USAGE, CC0_USAGE]),
      }),
    );
    const items = c.querySelectorAll('[data-testid="real-usage"] li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("anzart");
    expect(items[1].textContent).toContain("ddnktr");
  });

  it("未知许可（不在映射表内）—— 只显示许可名，不给猜测的链接", () => {
    const unknown = { ...CC_BY_USAGE, license: "CC BY-NC 4.0" };
    const c = mount(
      createElement(ExampleLayerBlock, { ...base, realUsage: realUsageOf([unknown]) }),
    );
    const block = c.querySelector('[data-testid="real-usage"]')!;
    const text = block.textContent ?? "";
    expect(text).toContain("CC BY-NC 4.0");
    // 没有许可链接，但句子页链接仍在
    const links = [...block.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://tatoeba.org/en/sentences/show/12673299"]);
  });
});

describe("ExampleLayerBlock · 「已核」文案不再与署名义务混淆", () => {
  it("verifiedCount > 0 → 文案是「产线自检 N 项」，不是「已核」", () => {
    const c = mount(createElement(ExampleLayerBlock, { ...base, verifiedCount: 2 }));
    const text = c.querySelector('[data-testid="ex-layer"]')!.textContent ?? "";
    expect(text).toContain("产线自检 2 项");
    // 旧文案会让人读成"来源已核验/署名已履行"，必须消失
    expect(text).not.toContain("已核");
  });

  it("verifiedCount = 0 → 不渲染自检徽章", () => {
    const c = mount(createElement(ExampleLayerBlock, { ...base, verifiedCount: 0 }));
    expect(c.querySelector('[data-testid="ex-layer"]')!.textContent).not.toContain("产线自检");
  });
});
