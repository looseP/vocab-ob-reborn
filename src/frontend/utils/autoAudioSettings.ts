/**
 * 自动伴读偏好（切卡自动播音频 · 2026-10-12）。
 *
 * ## 这是什么
 *
 * 复习/阶梯/打字各卡面在「卡变为可见」时按编排自动朗读一次，用听觉通道给视觉
 * 卡面再加一条编码通路（双编码）。读什么、读多少，按**卡面类别**配置 ——
 * 卡面的任务方向决定默认编排：
 *
 * - `en-word`（① 英文卡面：词形 + 英文例句）：`词 → 例句`。听读一致，
 *   看到词形听到词音、看到例句听到语流。
 * - `zh-meaning`（② 中文主卡面：中文释义 + 例句英中）：`释义 → 例句`。
 *   先听中文做一次「义 → 形」的内部检索预热，再听英文例句固化发音。
 * - `typing-en`（③a 打字·英文+中文可见）：`词`。打字前先听形。
 * - `typing-zh`（③b 打字·仅中文）：默认**关** —— 英文音频会直接把答案
 *   （词形）念出来，默写的产出练习就被泄题了；中文刚看过，再听冗余。
 *
 * 防泄题是这套默认值的硬约束，不是风格偏好：凡「答案在音频里」的卡面
 * （默写 / 完形挖空）默认不给英文轨。
 *
 * ## 存储纪律（照 ladderSettings / dailyReviewLimit 的既有约定）
 *
 * - 纯 localStorage，**不做服务端同步**（ADR-0036 §4 同款理由：这是设备偏好）；
 * - 单个 JSON 键 + **严格解析**：任何字段缺失/类型不对/越界，逐个字段回落
 *   默认值，绝不放任脏值改变播放行为；
 * - `vocab-` 前缀，与全站偏好键一致。
 */

import type { Accent } from "@/frontend/reviewFlow/speech";

/** 卡面类别（与卡面可见内容一一对应，见文件头）。 */
export type FaceClass = "en-word" | "zh-meaning" | "typing-en" | "typing-zh";

/** 朗读原子：词形（双轨）/ 英文例句 / 中文释义。 */
export type AudioUnit = "word" | "sentence" | "definition";

/** 一类卡面的编排：有序原子序列，或整类关闭。 */
export type Playlist = AudioUnit[] | "off";

export interface AutoAudioConfig {
  /** 总闸：关时所有卡面都不自动播（手动发音按钮不受影响）。 */
  master: boolean;
  /** 逐卡面编排。 */
  faces: Record<FaceClass, Playlist>;
  /** 翻卡（正→反）瞬间的编排，默认关 —— 切卡播一次是主语义，翻卡不重播。 */
  onReveal: Playlist;
  /** 段间停顿（毫秒）：上一段收尾与下一段起播之间的呼吸。 */
  gapMs: number;
}

export const AUTO_AUDIO_STORAGE_KEY = "vocab-auto-audio";

/** 口音偏好键：把此前「每会话重置回默认」的缺口补上（自动伴读依赖稳定口音）。 */
export const AUDIO_ACCENT_STORAGE_KEY = "vocab-audio-accent";

export const FACE_CLASSES: readonly FaceClass[] = ["en-word", "zh-meaning", "typing-en", "typing-zh"];

export const AUDIO_UNITS: readonly AudioUnit[] = ["word", "sentence", "definition"];

/** 段间默认停顿：TTS 收尾与下一段起播之间留呼吸，避免两段听感粘连。 */
export const DEFAULT_SEQUENCE_GAP_MS = 350;

export const DEFAULT_AUTO_AUDIO_CONFIG: AutoAudioConfig = {
  master: true,
  faces: {
    "en-word": ["word", "sentence"],
    "zh-meaning": ["definition", "sentence"],
    "typing-en": ["word"],
    "typing-zh": "off",
  },
  onReveal: "off",
  gapMs: DEFAULT_SEQUENCE_GAP_MS,
};

/** 卡面类别的中文名（设置页与开关提示共用，避免两处文案漂移）。 */
export const FACE_CLASS_LABELS: Record<FaceClass, string> = {
  "en-word": "英文卡面（词形 + 英文例句）",
  "zh-meaning": "中文卡面（中文释义 + 例句英中）",
  "typing-en": "打字 · 英文 + 中文可见",
  "typing-zh": "打字 · 仅中文（默写）",
};

export const AUDIO_UNIT_LABELS: Record<AudioUnit, string> = {
  word: "词",
  sentence: "例句",
  definition: "释义",
};

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 解析单个编排字段：非法值返回 null（调用方回落默认）。空数组归一为 "off"。 */
function parsePlaylist(value: unknown): Playlist | null {
  if (value === "off") return "off";
  if (!Array.isArray(value)) return null;
  const seen = new Set<AudioUnit>();
  const out: AudioUnit[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!AUDIO_UNITS.includes(item as AudioUnit)) continue;
    const unit = item as AudioUnit;
    if (seen.has(unit)) continue; // 去重：脏配置里同一单元出现两次只读一次
    seen.add(unit);
    out.push(unit);
  }
  return out.length > 0 ? out : "off";
}

/**
 * 读取自动伴读配置（严格解析，逐字段回落默认）。
 *
 * 与 ladderSettings 的「只认 1」同款纪律：配置损坏的最坏结果是**回到默认编排**，
 * 而不是把会话变成静音或无限复读。
 */
export function readAutoAudioConfig(): AutoAudioConfig {
  const fallback = DEFAULT_AUTO_AUDIO_CONFIG;
  const storage = safeStorage();
  if (!storage) return fallback;
  let raw: unknown;
  try {
    const text = storage.getItem(AUTO_AUDIO_STORAGE_KEY);
    if (!text) return fallback;
    raw = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (typeof raw !== "object" || raw === null) return fallback;
  const obj = raw as Record<string, unknown>;
  const rawFaces =
    typeof obj.faces === "object" && obj.faces !== null ? (obj.faces as Record<string, unknown>) : {};
  const faces = {} as Record<FaceClass, Playlist>;
  for (const face of FACE_CLASSES) {
    faces[face] = parsePlaylist(rawFaces[face]) ?? fallback.faces[face];
  }
  const gapMs =
    typeof obj.gapMs === "number" && Number.isFinite(obj.gapMs) && obj.gapMs >= 0 && obj.gapMs <= 2000
      ? Math.round(obj.gapMs)
      : fallback.gapMs;
  return {
    master: obj.master === undefined ? fallback.master : obj.master === true,
    faces,
    onReveal: parsePlaylist(obj.onReveal) ?? fallback.onReveal,
    gapMs,
  };
}

export function writeAutoAudioConfig(config: AutoAudioConfig): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(AUTO_AUDIO_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // 存储满 / 隐私模式：写入失败无副作用（本次会话仍按内存配置走）
  }
}

/** 读口音偏好；未设置（或脏值）返回 null，由调用方用 DEFAULT_ACCENT。 */
export function readAudioAccent(): Accent | null {
  const value = safeStorage()?.getItem(AUDIO_ACCENT_STORAGE_KEY);
  return value === "uk" || value === "us" ? value : null;
}

export function writeAudioAccent(accent: Accent): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(AUDIO_ACCENT_STORAGE_KEY, accent);
  } catch {
    // 同上：写入失败不影响当前会话
  }
}
