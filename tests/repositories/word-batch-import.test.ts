/**
 * `WordRepository.insertMany` 的模式与 outcome 计算测试。
 *
 * 纯 SQL 生成在 `tests/domain/batch-import-mode.test.ts`；这里验证 repository
 * 侧的接线：`mode` 是否传下去、`xmax` 是否被用来区分新增/更新、outcome 怎么算。
 */
import { describe, expect, it, vi } from "vitest";
import { WordRepository } from "@/repositories/word.repository";

type Row = { id: string; inserted_flag: boolean };

function spy(rows: Row[]) {
  const repo = new WordRepository();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = vi.spyOn(repo as any, "queryViaBatchPool").mockResolvedValue(rows);
  return { repo, q };
}

const one = (
  slug: string,
  short: string | null = "释义",
): Array<{ slug: string; title: string; lemma: string; pos: string | null; cefr: string | null; ipa: string | null; short_definition: string | null }> => [
  { slug, title: slug, lemma: slug, pos: null, cefr: null, ipa: null, short_definition: short },
];

describe("insertMany — outcome 计算", () => {
  it("全部新增：inserted_flag=true → inserted 计数", async () => {
    const { repo, q } = spy([
      { id: "a", inserted_flag: true },
      { id: "b", inserted_flag: true },
    ]);
    await expect(repo.insertMany([...one("a"), ...one("b")])).resolves.toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
    });
    expect(q).toHaveBeenCalledTimes(1);
  });

  // inserted_flag=false = 走了 DO UPDATE。搞反会让「更新」被报成「新增」，
  // 使用者就不知道自己的数据有没有被改动。
  //
  // 真实实现里这个布尔由 SQL 的 (xmax = 0) 算出 —— 不能在 JS 里判断 xmax，
  // 因为 xid 可能以文本 '0' 返回，而 Boolean('0') === true。
  it("全部更新：inserted_flag=false → updated 计数", async () => {
    const { repo } = spy([
      { id: "a", inserted_flag: false },
      { id: "b", inserted_flag: false },
    ]);
    await expect(repo.insertMany([...one("a"), ...one("b")])).resolves.toEqual({
      inserted: 0,
      updated: 2,
      unchanged: 0,
    });
  });

  it("混合：新增 + 更新 + 未变", async () => {
    const { repo } = spy([
      { id: "a", inserted_flag: true }, // 新增
      { id: "b", inserted_flag: false }, // 更新
      // c 走了 fill-only 的 no-op，不出现在结果里
    ]);
    await expect(repo.insertMany([...one("a"), ...one("b"), ...one("c")])).resolves.toEqual({
      inserted: 1,
      updated: 1,
      unchanged: 1,
    });
  });

  it("空输入不查库", async () => {
    const { repo, q } = spy([]);
    await expect(repo.insertMany([])).resolves.toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
    });
    expect(q).not.toHaveBeenCalled();
  });
});

describe("insertMany — 模式传递到 SQL", () => {
  it("默认走 fill-only：SQL 里不出现 definition_md 的赋值", async () => {
    const { repo, q } = spy([]);
    await repo.insertMany(one("abandon"));

    const sql = String(q.mock.calls[0]![0]);
    // INSERT 的列清单里必然有 definition_md（NOT NULL），要断言的是
    // **冲突分支的 SET 子句**里没有对它的赋值。
    const conflictPart = sql.slice(sql.indexOf("ON CONFLICT"));
    expect(conflictPart).not.toMatch(/definition_md\s*=\s*EXCLUDED/);
    expect(conflictPart).toMatch(/COALESCE\(NULLIF\(words\.short_definition/);
    expect(conflictPart).toMatch(/^[\s\S]*WHERE words\.pos IS DISTINCT FROM/m);
  });

  it("显式 overwrite：恢复旧的全覆盖 SQL", async () => {
    const { repo, q } = spy([]);
    await repo.insertMany(one("abandon"), "overwrite");

    const sql = String(q.mock.calls[0]![0]);
    const conflictPart = sql.slice(sql.indexOf("ON CONFLICT"));
    expect(conflictPart).toMatch(/definition_md\s*=\s*EXCLUDED\.definition_md/);
    // overwrite 不带守卫
    expect(conflictPart).not.toMatch(/IS DISTINCT FROM/);
  });
});

describe("insertMany — 参数派生", () => {
  it("short_definition 缺省时按空串派生，不传 null", async () => {
    const { repo, q } = spy([]);
    await repo.insertMany(one("x", null));

    const params = q.mock.calls[0]![1] as unknown[];
    // params.push 的顺序（0-based）：
    //   0 slug / 1 title / 2 lemma / 3 pos / 4 cefr / 5 ipa
    //   6 short_definition / 7 content_hash / 8 source_path
    //   9 definition_md / 10 body_md / 11 pinyin / 12 pinyin_initial
    expect(params[6]).toBe("");
    expect(params[9]).toBe("");
    expect(params[10]).toBe("");
    // pinyin 由短释义派生；短释义为空时无拼音可取
    expect(params[11]).toBeNull();
  });

  it("content_hash 由入参字段派生（满足 64-hex CHECK 与唯一约束）", async () => {
    const { repo, q } = spy([]);
    await repo.insertMany(one("x", "释义"));

    const params = q.mock.calls[0]![1] as unknown[];
    expect(String(params[7])).toMatch(/^[0-9a-f]{64}$/);
    expect(params[8]).toBe("batch-import/x.md");
  });

  it("每行参数个数固定（13），便于拼接 VALUES", async () => {
    const { repo, q } = spy([]);
    await repo.insertMany([...one("a"), ...one("b")]);

    const sql = String(q.mock.calls[0]![0]);
    const params = q.mock.calls[0]![1] as unknown[];
    // 两行 = 26 个参数；占位符最高编号也必须是 26
    expect(params.length).toBe(26);
    expect(sql).toContain("$26");
  });
});