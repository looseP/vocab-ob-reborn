/**
 * 题型空间文件定位的 URL 层（纯逻辑，2026-09-27）——「打开的文件住 URL」的构造。
 *
 * 问题（执行文档 `l3-exam-mode-engine-execution-2026-09-27.md` 缺口 A）：`openFile`
 * 此前只 `apiFetch` + `setDetail`，**不写 URL** ⇒ 刷新、分享、收藏、浏览器后退全部
 * 丢位置。深链**读**的通道一直存在（`?venue=&file=`，`L3PapersPage` 一次性消费），
 * 缺的只是**写**——所以本模块只补写侧，不新建第二条深链机制。
 *
 * 与 `examModeNavigation.ts` 同款纪律：单一构造入口、参数顺序稳定、**保留**其余全部
 * 参数。保留不是客气：`?mode=`（卷面模式，B3）住在同一个 query 里，若按「拼一个新
 * URL」的写法 `?file=`，切文件会顺手把用户的解析档打回做题档——那正是本仓反复登记的
 * 「顺手改坏相邻状态」类缺陷。
 *
 * 身份口径与 `fileOrderNavigation.sameFileIdentity` 同源：文件的引用是
 * `file_key ?? source_id`（fileKey 优先；source 型文件无 fileKey 时以 sourceId 代入）。
 * 写成 URL 的引用必须是深链匹配器**认得的**那个，否则「写进去的地址打不开」。
 */

/** 题型参数名（与 `file` / `paper` / `sheet` / `mode` 同级）。 */
export const PRACTICE_VENUE_PARAM = "venue";
/** 文件引用参数名（source 型 = sourceId，fileKey 型 = file_key）。 */
export const PRACTICE_FILE_PARAM = "file";

/** 试卷台所在的 shell section 参数值（`l3SectionNavigation` 的 `papers` 契约）。 */
const PAPERS_SECTION_PARAM = "papers";

/** 取文件的 URL 引用：`file_key` 优先，缺省回 `source_id`（同 `sameFileIdentity`）。 */
export function practiceFileRef(file: { source_id: string | null; file_key: string | null }): string | null {
  return file.file_key ?? file.source_id;
}

export interface PracticeFileUrlInput {
  /** 题型（QuestionType）；`venue` 参数值。 */
  questionType: string;
  /** 文件引用；`null` = 回到该题型的文件列表（清掉 `file`）。 */
  fileRef: string | null;
}

/**
 * 在既有 href 上写入「当前打开的文件」，**保留**其余全部参数。
 *
 * - 总是显式写 `section=papers`：让这个 URL 自足（复制到新标签页能落到同一份），
 *   不依赖「用户是怎么走到这儿的」；
 * - `fileRef = null` → 删除 `file`（返回列表时位置参数必须跟着消失，否则刷新会把
 *   用户刚退出的文件重新打开）；
 * - `venue` 恒写：题型空间的面也是位置，离开该题型时 `?venue=` 是唯一线索。
 */
export function buildPracticeFileUrl(href: string, input: PracticeFileUrlInput): string {
  const url = new URL(href, "http://l3.local");
  url.searchParams.set("section", PAPERS_SECTION_PARAM);
  url.searchParams.set(PRACTICE_VENUE_PARAM, input.questionType);
  if (input.fileRef === null) {
    url.searchParams.delete(PRACTICE_FILE_PARAM);
  } else {
    url.searchParams.set(PRACTICE_FILE_PARAM, input.fileRef);
  }
  // URLSearchParams 保留插入序；按 key 排序，让输出与传入参数顺序无关（同 buildExamModeUrl）。
  url.searchParams.sort();
  const search = url.searchParams.toString();
  return `${url.pathname}${search.length > 0 ? `?${search}` : ""}${url.hash}`;
}
