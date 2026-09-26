/**
 * 题型空间文件顺序导航（2026-09-26）——「上一文件 / 下一文件」的纯逻辑。
 *
 * 问题：做完一个文件后回到列表、挑下一个、再点开 —— 每换一份卷都是 3 次点击，
 * 而"连着做"是做题的真实节奏。设计基线要求表面顶栏提供上一/下一文件与
 * "返回文件列表"，且"切换不回首页、摩擦最小"（`l3-subspace-venue-design-card`
 * §85 / §105）。
 *
 * 身份口径：文件的身份是 `(question_type, source_id | file_key)`——这正是
 * `listPracticeFiles` 的行形态与 `?file=` 深链参数的匹配规则（source 型文件无
 * fileKey 时以 sourceId 代入）。此模块只按**列表原序**取邻居，不改排序、不分组、
 * 不跳题（"下一份" = 列表里的下一份，不是"最该做的那份"——那是待办队列的职责，
 * 本轮不做，且两者混在一起会让"下一份"变得不可预期）。
 *
 * 边界：
 *  - 纯函数，无 React / 无网络 → 可单测；
 *  - 认不出当前文件时返回 `{previous: null, next: null}`（**不猜**：不默认跳第一份，
 *    那会让用户丢了自己刚做完的位置）；
 *  - `fileKey` 型文件（翻译/作文无 source）目前只能浏览、不能开纸，导航照样给出
 *    ——用户点进去看到的是浏览视图，这与列表里点它得到的结果一致。
 */

/** 题型空间文件行（与 L3PapersPage 的 PracticeFile 同形，此处只取导航所需字段）。 */
export interface OrderedPracticeFile {
  question_type: string;
  source_id: string | null;
  file_key: string | null;
  title: string;
  question_count: number;
}

/** 当前打开文件的身份。 */
export interface FileIdentity {
  questionType: string;
  sourceId: string | null;
  fileKey: string | null;
}

export interface FileSiblings {
  previous: OrderedPracticeFile | null;
  next: OrderedPracticeFile | null;
  /** 当前文件在列表中的下标；-1 = 不在列表里（认不出身份）。 */
  index: number;
  /** 列表长度（用于文案「第 n / m 份」）。 */
  total: number;
}

/** 身份是否匹配：source 型用 sourceId、fileKey 型用 fileKey（fileKey 优先）。 */
export function sameFileIdentity(file: OrderedPracticeFile, identity: FileIdentity): boolean {
  if (file.question_type !== identity.questionType) return false;
  const ref = identity.fileKey ?? identity.sourceId;
  if (ref == null) return false;
  return file.file_key === ref || file.source_id === ref;
}

export function findFileSiblings(
  files: readonly OrderedPracticeFile[],
  identity: FileIdentity | null,
): FileSiblings {
  const total = files.length;
  if (identity == null) return { previous: null, next: null, index: -1, total };
  const index = files.findIndex((file) => sameFileIdentity(file, identity));
  if (index < 0) return { previous: null, next: null, index: -1, total };
  return {
    previous: index > 0 ? files[index - 1]! : null,
    next: index < total - 1 ? files[index + 1]! : null,
    index,
    total,
  };
}

/** 顶栏文案：「第 3 / 12 份」；认不出身份时给「共 12 份」（不谎报位置）。 */
export function filePositionLabel(siblings: FileSiblings): string {
  if (siblings.index < 0) return siblings.total > 0 ? `共 ${siblings.total} 份` : "";
  return `第 ${siblings.index + 1} / ${siblings.total} 份`;
}

/** 邻项按钮文案（带目标文件名，减少一次悬停/确认）。 */
export function fileSiblingLabel(file: OrderedPracticeFile | null, fallback: string): string {
  if (file == null) return fallback;
  const name = file.title.trim();
  return name.length > 0 ? `${fallback}：${name}` : fallback;
}
