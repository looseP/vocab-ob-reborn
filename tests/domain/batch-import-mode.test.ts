/**
 * 批量导入写入模式（`POST /words/batch` = 导入页的「JSON 粘贴」）的纯函数测试。
 *
 * ## 为什么这组测试重要
 *
 * 这条路径历史上无条件覆盖：`ON CONFLICT (slug) DO UPDATE SET ... = EXCLUDED.*`。
 * 而 `definition_md` / `body_md` 在这条路径上是**从 `short_definition` 派生**的，
 * 所以往导入页粘一个库里已有的词，会把它的结构化释义冲成一句话。
 *
 * 实测（PR #185 的起因）：`abandon` 的 definition_md 从 240 字符塌缩成 19 字符；
 * `short_definition` 缺省时更会变成空串 —— 等于把词条打成 stub。
 *
 * 这类缺陷的表现是「静默破坏用户数据」，所以断言必须落在**生成的 SQL 片段**上，
 * 而不是「跑一下看看没坏」—— 后者在没有真实数据时是查不出来的。
 */
import { describe, expect, it } from "vitest";
import {
  BATCH_IMPORT_MODES,
  DEFAULT_BATCH_IMPORT_MODE,
  conflictGuardClause,
  conflictUpdateClause,
  isBatchImportMode,
} from "@/domain/ingest/batch-import-mode";

describe("isBatchImportMode", () => {
  it("只接受两种已知模式", () => {
    expect(isBatchImportMode("fill-only")).toBe(true);
    expect(isBatchImportMode("overwrite")).toBe(true);
  });

  // 拼错模式必须落到默认值而不是被当成 overwrite —— 那等于静默授权破坏数据。
  it.each(["", "fill", "FILL-ONLY", "merge", "delete", null, undefined, 0, {}])(
    "非法值 %p 不被接受",
    (v) => {
      expect(isBatchImportMode(v)).toBe(false);
    },
  );

  it("默认是 fill-only（安全侧）", () => {
    expect(DEFAULT_BATCH_IMPORT_MODE).toBe("fill-only");
    expect(BATCH_IMPORT_MODES).toEqual(["fill-only", "overwrite"]);
  });
});

describe("conflictUpdateClause — fill-only", () => {
  const sql = conflictUpdateClause("fill-only");

  // 这两条是本 PR 的全部意义所在。写错的后果是静默毁掉用户维护的释义，
  // 而它不会报错、不会失败、只会在几周后被发现。
  it("绝不写 definition_md", () => {
    expect(sql).not.toMatch(/definition_md\s*=/);
  });

  it("绝不写 body_md", () => {
    expect(sql).not.toMatch(/body_md\s*=/);
  });

  it("不写 content_hash（fill-only 下内容没变，hash 不该被动）", () => {
    expect(sql).not.toMatch(/content_hash\s*=/);
  });

  it("不写 source_path（来源是既有事实，不该被批量导入改写）", () => {
    expect(sql).not.toMatch(/source_path\s*=/);
  });

  it("不写 title / lemma（标识字段不从批量导入改）", () => {
    expect(sql).not.toMatch(/title\s*=/);
    expect(sql).not.toMatch(/lemma\s*=/);
  });

  it("已有非空字段不被覆盖：逐个走 COALESCE(旧值, 新值)", () => {
    for (const col of ["pos", "cefr", "ipa", "short_definition", "pinyin", "pinyin_initial"]) {
      expect(sql).toMatch(new RegExp(col + "\\s*=\\s*COALESCE\\("));
    }
  });

  it("空串也算「空」—— 否则导入一个空释义会把已有释义擦成空", () => {
    // short_definition / pinyin 用 NULLIF(旧值,'') 包裹：
    // 库里存在「有行但内容是空串」的状态，只判 NULL 不够。
    expect(sql).toMatch(/short_definition\s*=\s*COALESCE\(NULLIF\(words\.short_definition,\s*''\)/);
  });
});

describe("conflictUpdateClause — overwrite", () => {
  const sql = conflictUpdateClause("overwrite");

  it("恢复旧的全覆盖行为（含派生出来的 definition_md / body_md）", () => {
    expect(sql).toMatch(/definition_md\s*=\s*EXCLUDED\.definition_md/);
    expect(sql).toMatch(/body_md\s*=\s*EXCLUDED\.body_md/);
    expect(sql).toMatch(/short_definition\s*=\s*EXCLUDED\.short_definition/);
    expect(sql).toMatch(/content_hash\s*=\s*EXCLUDED\.content_hash/);
  });
});

describe("conflictGuardClause", () => {
  it("fill-only 有守卫：什么都没补上就整行不动", () => {
    const sql = conflictGuardClause("fill-only");
    expect(sql).toMatch(/^WHERE/);
    expect(sql).toMatch(/IS DISTINCT FROM/);
    // 每个可能被填的字段都要参与判定，否则某字段静默不生效而无从察觉
    for (const col of ["pos", "cefr", "ipa", "short_definition", "pinyin", "pinyin_initial"]) {
      expect(sql).toMatch(new RegExp(col));
    }
  });

  // overwrite 是「无条件覆盖」，加守卫会让「改成一样的值」被当成未变 —— 与语义矛盾。
  it("overwrite 无守卫", () => {
    expect(conflictGuardClause("overwrite")).toBe("");
  });
});

describe("两模式的差异集中在高危字段", () => {
  it("fill-only 写到的列集合是 overwrite 的真子集去掉高危列", () => {
    const fill = conflictUpdateClause("fill-only");
    const over = conflictUpdateClause("overwrite");
    const cols = (s: string) => new Set((s.match(/(\w+)\s*=/g) ?? []).map((x) => x.replace(/\s*=$/, "").trim()));
    const f = cols(fill);
    const o = cols(over);
    for (const c of f) {
      expect(o.has(c), `fill-only 写了 ${c}，overwrite 应当也写`).toBe(true);
    }
    // overwrite 多出来的正是危险的那几个
    const extra = [...o].filter((c) => !f.has(c));
    expect(extra).toEqual(expect.arrayContaining(["definition_md", "body_md", "content_hash"]));
  });
});