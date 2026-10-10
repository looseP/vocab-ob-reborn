/**
 * `/api/review/queue` 的 query 解析单测（2026-10-10 通道隔离）。
 *
 * **为什么必须直测这个文件**：
 * ① `src/http/**` 属分层覆盖率的 **governed 层**（见 `scripts/report-layered-coverage.ts`
 *    的 `isGovernedSourceFile`），新写 80 行却只靠路由间接覆盖会让 **Diff coverage 门禁**
 *    判红（PR #220 第三轮 CI 就是这么挂的：diff 67.13% < 85%）。
 * ② 更根本的理由：这些函数是**入参不可信**的第一道防线（白名单枚举 + 边界收敛），
 *    路由层的集成测试只能证明「参数被透传」，证明不了「脏值被收敛」。
 *
 * 钉住的边界（每条都对应一个真实可能出错的场景）：
 *  - 未知 channel 回落 null（fail-open 到旧行为）而不是抛错 —— 客户端版本落后时
 *    不该让整个复习页打不开；
 *  - limit/offset 的 clamp 与NaN 回落（`parseInt("abc") || 20` 这个 `||` 的妙用）；
 *  - wordIds 的空串过滤与顺序保留（用户勾选顺序就是浏览顺序）。
 */
import { describe, it, expect } from "vitest";
import {
  MAX_NEW_CARDS_LIMIT_CAP,
  parseNewCardsLimit,
  parseReviewChannel,
  parseReviewQueueQuery,
} from "@/http/routes/review-channel-params";

/** 模拟 Hono 的 c.req.query：只从给定的 query map 取值。 */
function q(map: Record<string, string>) {
  return (key: string) => map[key];
}

describe("parseReviewChannel — 白名单枚举", () => {
  it("识别两条合法通道", () => {
    expect(parseReviewChannel("review")).toBe("review");
    expect(parseReviewChannel("new")).toBe("new");
  });

  it("未知值回落 null（fail-open，不抛错）", () => {
    // 关键设计：读侧参数，客户端版本落后时不该让整个复习页 400/500。
    expect(parseReviewChannel("all")).toBeNull();
    expect(parseReviewChannel("REVIEW")).toBeNull(); // 大小写敏感，防枚举绕过
    expect(parseReviewChannel("review; DROP TABLE")).toBeNull();
  });

  it("缺省 / 空串 / null 均为 null（= 混流旧行为）", () => {
    expect(parseReviewChannel(undefined)).toBeNull();
    expect(parseReviewChannel("")).toBeNull();
    expect(parseReviewChannel(null)).toBeNull();
  });
});

describe("parseNewCardsLimit — 边界收敛", () => {
  it("合法正整数原样透传", () => {
    expect(parseNewCardsLimit("5")).toBe(5);
    expect(parseNewCardsLimit("20")).toBe(20);
    expect(parseNewCardsLimit("100")).toBe(100);
  });

  it("超过上限被封顶（防止单次新学爆量）", () => {
    expect(parseNewCardsLimit("99999")).toBe(MAX_NEW_CARDS_LIMIT_CAP);
    expect(parseNewCardsLimit(String(MAX_NEW_CARDS_LIMIT_CAP))).toBe(MAX_NEW_CARDS_LIMIT_CAP);
  });

  it("0 与负数 → undefined（回落到通道默认，不等于「0 张」）", () => {
    // 0 在设置页语义是「不限」，但在**单次请求**里 0 张毫无意义 ⇒ 交给默认值。
    // 这条还兜住一个隐式依赖：buildReviewQueueBatch 里判定用 `maxNewCards ?? 默认`，
    // 若这里放行 0，0 是 falsy 但 `??` 只兜 null/undefined ⇒ 新词通道会一张都不出。
    // 解析层放行 0 就等于给「不出卡」开了个后门。
    expect(parseNewCardsLimit("0")).toBeUndefined();
    expect(parseNewCardsLimit("-5")).toBeUndefined();
  });

  it("非数字 → undefined（脏数据不放开闸门）", () => {
    expect(parseNewCardsLimit("abc")).toBeUndefined();
    expect(parseNewCardsLimit("NaN")).toBeUndefined();
    // parseInt 按前缀截断："1e5" → 1（不是科学计数法 100000），收敛到 1 而非放开闸门。
    expect(parseNewCardsLimit("1e5")).toBe(1);
    expect(parseNewCardsLimit("12abc")).toBe(12);
  });

  it("空白串视作缺省", () => {
    expect(parseNewCardsLimit("")).toBeUndefined();
    expect(parseNewCardsLimit("   ")).toBeUndefined();
    expect(parseNewCardsLimit(null)).toBeUndefined();
    expect(parseNewCardsLimit(undefined)).toBeUndefined();
  });
});

describe("parseReviewQueueQuery — /queue 的全部 query", () => {
  it("空 query 返回安全的缺省值（20 张 / review 通道 / 混流）", () => {
    const r = parseReviewQueueQuery(q({}));
    expect(r).toEqual({
      limit: 20,
      offset: 0,
      mode: "review",
      wordIds: undefined,
      channel: null,
      maxNewCards: undefined,
    });
  });

  it("limit 收敛到 [1,100]（防止一次拉爆候选池）", () => {
    expect(parseReviewQueueQuery(q({ limit: "50" })).limit).toBe(50);
    expect(parseReviewQueueQuery(q({ limit: "100" })).limit).toBe(100);
    expect(parseReviewQueueQuery(q({ limit: "999" })).limit).toBe(100);
    // 非法值（NaN / 负数）回落 20；0 被抬到下界 1（要 0 张请求本身无意义）。
    expect(parseReviewQueueQuery(q({ limit: "0" })).limit).toBe(1);
    expect(parseReviewQueueQuery(q({ limit: "abc" })).limit).toBe(20);
    // 回归防线：原先 `Math.min(parseInt(...) || 20, 100)` 只夹上界，
    // `?limit=-5` 会把 -5 透传给 SQL `LIMIT -5` ⇒ 数据库直接报错。
    expect(parseReviewQueueQuery(q({ limit: "-5" })).limit).toBe(1);
  });

  it("offset 不得为负（负值会让SQL OFFSET 报错）", () => {
    expect(parseReviewQueueQuery(q({ offset: "0" })).offset).toBe(0);
    expect(parseReviewQueueQuery(q({ offset: "1900" })).offset).toBe(1900);
    expect(parseReviewQueueQuery(q({ offset: "-1" })).offset).toBe(0);
    expect(parseReviewQueueQuery(q({ offset: "abc" })).offset).toBe(0);
  });

  it("mode 只认 cram / preview，其余归 review", () => {
    expect(parseReviewQueueQuery(q({ mode: "cram" })).mode).toBe("cram");
    expect(parseReviewQueueQuery(q({ mode: "preview" })).mode).toBe("preview");
    // 未知 mode 不透传进服务层（mode 进 FSRS 写入路径，绝不能放过脏值）
    expect(parseReviewQueueQuery(q({ mode: "hack" })).mode).toBe("review");
    expect(parseReviewQueueQuery(q({ mode: "" })).mode).toBe("review");
  });

  it("wordIds 按用户勾选顺序保留（顺序即浏览顺序）", () => {
    expect(parseReviewQueueQuery(q({ wordIds: "w3,w1,w2" })).wordIds).toEqual(["w3", "w1", "w2"]);
  });

  it("wordIds 过滤空项与空串", () => {
    // 用户勾选变化时前端可能拼出 "w1,,w2" ⇒ 空项必须滤掉，否则会查一个空 id。
    expect(parseReviewQueueQuery(q({ wordIds: "w1,,w2" })).wordIds).toEqual(["w1", "w2"]);
    expect(parseReviewQueueQuery(q({ wordIds: "" })).wordIds).toBeUndefined();
    expect(parseReviewQueueQuery(q({ wordIds: "," })).wordIds).toEqual([]);
  });

  it("通道与配额一起透传（前端 mode→channel 映射后的落点）", () => {
    const learn = parseReviewQueueQuery(q({ channel: "new", newCardsLimit: "30" }));
    expect(learn.channel).toBe("new");
    expect(learn.maxNewCards).toBe(30);

    const review = parseReviewQueueQuery(q({ channel: "review" }));
    expect(review.channel).toBe("review");
    expect(review.maxNewCards).toBeUndefined();
  });

  it("全参数组合一次性解析（路由里就靠这一行）", () => {
    const r = parseReviewQueueQuery(
      q({ limit: "30", offset: "60", mode: "cram", wordIds: "w1,w2", channel: "new", newCardsLimit: "9999" }),
    );
    expect(r).toEqual({
      limit: 30,
      offset: 60,
      mode: "cram",
      wordIds: ["w1", "w2"],
      channel: "new",
      maxNewCards: MAX_NEW_CARDS_LIMIT_CAP,
    });
  });
});