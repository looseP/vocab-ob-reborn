/**
 * 卷面三模式的可见性判定（纯逻辑，2026-09-27）。
 *
 * 规格来源：`docs/plan/l3-subspace-venue-design-card-2026-09-16.md` §2.4 的可见性矩阵
 * + `docs/plan/l3-exam-mode-engine-execution-2026-09-27.md` §3.2（映射到今天真实存在的
 * 14 个元素）与 §3.5（判定不进组件）。
 *
 * **为什么单独成模块**：`L3ExamPaper.tsx` 已 2538 行，而
 * `docs/plan/study-notes-design-2026-09-18.md:194` 写着「新功能不得把全部逻辑塞进
 * 近两千行 L3ExamPaper」。本模块无 React / 无网络 ⇒ 可整表单测；组件只负责按判定渲染。
 *
 * **本模块不知道的事**（判定不掺进来，由调用方 AND）：
 * - 题纸状态（`draft` / `sealed`）—— `canAnswer` 只说「本模式允许作答」，
 *   组件还要 AND `sheet.status === "draft"`；
 * - 评卷是否存在 —— 矩阵说 practice 档未评时显示「待评卷」，那是渲染分支不是可见性。
 *
 * 字段名沿「show* / can*」两类分界：show* 管**呈现**，can* 管**是否允许写**。
 * 二者混用会出现「按钮可见但点不动」或「只读态却留着写入口」两种坏体验。
 */

import { EXAM_MODE_DEFAULT, type ExamMode } from "./examModeNavigation";

/**
 * 某一模式下每类元素的可见性 / 可写性。
 *
 * 一字段一行，与设计卡 §2.4 矩阵逐行对应。**新增元素时必须先在矩阵里定位**
 * ——「忘了加字段」在本模块里表现为「沿用上一档的行为」，而那通常正是剧透。
 */
export interface ExamVisibility {
  // ── 基础面：三档都显 ──
  /** 材料正文 + 题面。 */
  showMaterial: boolean;
  /** 学习笔记侧栏可达（签字项 S-2：侧栏是**工具**不是痕迹，且纯净模式用途之一是打印）。 */
  showNotesPanel: boolean;

  // ── 用户痕迹层：纯净档全隐 ──
  /** 选项已选高亮（草稿作答痕迹）。 */
  showPicked: boolean;
  /** 用户划重点（passage mark）。 */
  showUserMarks: boolean;
  /** 用户注记：原文分析条目的锚点高亮 + 侧边子区。 */
  showAnnotations: boolean;
  /** 评析（owner 的复盘沉淀）。 */
  showAssessments: boolean;

  // ── 答案面：仅解析档 ──
  /** 官方 evidence 在原文中的高亮（agent 录题时标的标准答案区间）。 */
  showEvidence: boolean;
  /** 选项判定配色（对/错/淡化）。 */
  showOptionVerdict: boolean;
  /** 题目官方解析。 */
  showExplanation: boolean;
  /** 参考译文 / 参考范文。 */
  showReferenceAnswer: boolean;
  /** 评卷判读（verdict 徽标 + agent 分析）。 */
  showGrading: boolean;
  /** header 的「答对 N / 估算 X 分」（G-0 剧透门控）。 */
  showScore: boolean;

  // ── 进度面 ──
  /** 评卷覆盖度条（「已评 n/m」）。解析侧信息，纯净档隐藏。 */
  showGradingCoverage: boolean;

  // ── 可写性 ──
  /**
   * 本模式是否**允许**作答。组件必须 AND 上题纸状态（只有 draft 能写）。
   *
   * 解析档为 false：attempt 是不可变作答事实（ADR-0034 §2），「切到解析顺手改答案」
   * 会绕过它。纯净档为 false：它是只读查看面（设计卡矩阵「用户作答：纯净 ❌」）。
   */
  canAnswer: boolean;
}

const ALL_HIDDEN_ANSWER_FACE = {
  showEvidence: false,
  showOptionVerdict: false,
  showExplanation: false,
  showReferenceAnswer: false,
  showGrading: false,
  showScore: false,
} as const;

const ALL_SHOWN_ANSWER_FACE = {
  showEvidence: true,
  showOptionVerdict: true,
  showExplanation: true,
  showReferenceAnswer: true,
  showGrading: true,
  showScore: true,
} as const;

/** 三档的完整判定表。纯数据，无分支 ⇒ 逐格断言是穷尽的。 */
const VISIBILITY: Record<ExamMode, ExamVisibility> = {
  // 纯净：干净卷面（打印 / 首看 / 重考）。用户痕迹与答案面全隐，只读。
  //
  // ⚠️ 评析（showAssessments）在纯净档**保持可见** —— 与设计卡 §2.4 的一处有意偏离
  // （B3 实现期登记）。理由是 S-1 原则本身：「隐藏必须自带声明」。评析只有单题 GET
  // （`/l3/questions/:id/assessment`），卷面载荷不带评析事实 ⇒ 父层**数不出条数**
  // ⇒ 数不出就无法在声明条里如实告知 ⇒ 按原则不隐藏。
  // 重开条件：出现批量评析读面时，改成「隐藏 + 计数声明」。
  pure: {
    showMaterial: true,
    showNotesPanel: true,
    showPicked: false,
    showUserMarks: false,
    showAnnotations: false,
    showAssessments: true,
    ...ALL_HIDDEN_ANSWER_FACE,
    showGradingCoverage: false,
    canAnswer: false,
  },
  // 做题：续做现场。痕迹全显、答案全隐、可作答。
  practice: {
    showMaterial: true,
    showNotesPanel: true,
    showPicked: true,
    showUserMarks: true,
    showAnnotations: true,
    showAssessments: true,
    ...ALL_HIDDEN_ANSWER_FACE,
    showGradingCoverage: true,
    canAnswer: true,
  },
  // 解析修正：答案面全显、只读陈列。
  review: {
    showMaterial: true,
    showNotesPanel: true,
    showPicked: true,
    showUserMarks: true,
    showAnnotations: true,
    showAssessments: true,
    ...ALL_SHOWN_ANSWER_FACE,
    showGradingCoverage: true,
    canAnswer: false,
  },
};

/** 取某一模式的判定表。未知模式**不**回落默认（那会静默错显），直接抛 —— 枚举由本仓守。 */
export function visibilityFor(mode: ExamMode): ExamVisibility {
  const visibility = VISIBILITY[mode];
  if (visibility === undefined) {
    throw new Error(`unknown exam mode: ${String(mode)}`);
  }
  return visibility;
}

/** 缺省档的判定表（组件的初值来源）。 */
export function defaultVisibility(): ExamVisibility {
  return visibilityFor(EXAM_MODE_DEFAULT);
}

/** 纯净模式下会被隐藏的用户痕迹计数（用于「已隐藏 N 处」声明条）。 */
export interface HiddenTraceCounts {
  /** 用户划重点处数。 */
  marks: number;
  /** 用户注记条数。 */
  annotations: number;
  /**
   * 评析条数。**当前卷面数不出**（评析只有单题 GET，卷面载荷不带该事实）⇒ 纯净档
   * 评析不隐藏，调用方此处恒传 0；出现批量读面后才生效。
   */
  assessments: number;
  /** 已有作答的题数（选项已选 / 译文 / 作文）。 */
  picked: number;
}

/**
 * 纯净模式的「已隐藏 N 处」声明条文案；无需声明时返回 `null`。
 *
 * **为什么必须有它**（签字项 S-1 / 护栏 G-2）：纯净模式按设计隐藏用户自己的
 * 标注、高亮与作答，但用户无法区分「被隐藏」与「弄丢了」。静默隐藏自己的劳动成果
 * 是本仓反复登记过的反模式（F-1 / F-2 同族：行为合理但未言明 ⇒ 后来者误判为缺陷
 * 并「修复」）。所以隐藏必须**自带声明**。
 *
 * 计数为 0 的类别不出现在文案里（全 0 时返回 `null` —— 不显示无意义的「已隐藏 0 处」）。
 */
export function hiddenTraceNotice(
  mode: ExamMode,
  counts: HiddenTraceCounts,
): string | null {
  if (mode !== "pure") return null;
  const parts: string[] = [];
  if (counts.marks > 0) parts.push(`${counts.marks} 处高亮`);
  if (counts.annotations > 0) parts.push(`${counts.annotations} 条注记`);
  if (counts.assessments > 0) parts.push(`${counts.assessments} 条评析`);
  if (counts.picked > 0) parts.push(`${counts.picked} 处已选作答`);
  if (parts.length === 0) return null;
  return `纯净模式已隐藏你的 ${parts.join("、")}（切回做题或解析模式可见）`;
}
