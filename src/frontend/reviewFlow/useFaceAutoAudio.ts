/**
 * useFaceAutoAudio —— 切卡自动伴读钩子（2026-10-12）。
 *
 * 卡面挂载（或 `triggerKey` 变化 = 换卡/换档）时，按该卡面类别的编排
 * **自动朗读一次**；卸载或再次触发前先掐断上一段（不留幽灵音轨）。
 *
 * 三条设计约束（都来自实测过的坑，不是风格偏好）：
 *
 * 1. **走卡面自带的音频控制器**：`playSequence` 复用在 `useAudioController`
 *    里，互斥/防抖/卸载收尾/声学胶囊动画全部沿用既有轨道 —— 自动播报不是
 *    第二条音频通路，绕过控制器会出现「界面没动画、耳机在念」的分裂观感。
 * 2. **用户动作永远优先**：控制器内任何手动播放（R / E / 点按钮）都会
 *    `interruptCurrent()` → 连带取消在途编排，序列不会从下一段复活。
 * 3. **编排按卡面类别读配置，每卡现读**：会话中途改设置，下一张卡生效
 *    （读一次 localStorage 的成本低于订阅整套配置）。
 * 4. **超长例句整条跳过**：自动播报是**不可随时按停的等待**，法规条文式长句
 *    念完要十几秒、追着上一张卡念，故 `buildUnits` 直接在组队阶段剔除
 *    （手动「听例句」不受此限，时长由用户自己掌握）。
 *
 * 依赖数组只收**稳定引用**（控制器的方法是 useCallback，available 是
 * useMemo）与原始值 —— 控制器对象本身每次渲染都是新身份，不能进依赖。
 */

import { useEffect, useRef } from "react";
import {
  estimateSpeechMs,
  type AudioController,
  type AudioSequenceUnit,
} from "@/frontend/reviewFlow/audioEngine";
import { readAutoAudioConfig, type FaceClass, type Playlist } from "@/frontend/utils/autoAudioSettings";

/**
 * 自动朗读例句的时长上限（毫秒估算）：超过它的例句整条跳过。
 *
 * 取值理由：`estimateSpeechMs` 按 70ms/字符估算，10s ≈ 143 字符 —— 正好卡在
 * 「例句该有的长度」与「读起来开始占用卡面时间」的边界上。真被跳过的句子里
 * 用户仍能手动点读。
 */
export const AUTO_SENTENCE_MAX_MS = 10_000;

export interface FaceAutoAudioInput {
  /** 卡面类别（决定读哪套编排）。 */
  face: FaceClass;
  /** 重触发键：换卡/换档即变（progressId、tier…）。 */
  triggerKey: string;
  lemma?: string | null;
  sentence?: string | null;
  definition?: string | null;
  /**
   * 翻卡（正 → 反）状态：仅在 **false → true** 的那一刻触发 `config.onReveal`
   * 编排（默认 off = 不播）。
   *
   * 不传 = 该卡面无翻卡概念（照着打 / 默写）。到达时已是揭示态（preview 直展）
   * 不触发 —— 那是「切卡播一次」的语义，已由 `face` 编排承担，不重复。
   */
  revealed?: boolean;
  /** 卡面音频控制器：取其稳定方法与可用性。 */
  controller: Pick<AudioController, "available" | "playSequence" | "stop">;
}

/** 按编排组装朗读单元；空文本单元剔除（stub 词自动降级）、超长例句整条跳过。 */
function buildUnits(
  playlist: Playlist,
  source: { lemma?: string | null; sentence?: string | null; definition?: string | null },
): AudioSequenceUnit[] {
  if (playlist === "off") return [];
  const textOf = {
    word: source.lemma ?? "",
    sentence: source.sentence ?? "",
    definition: source.definition ?? "",
  } as const;
  return playlist
    .map((kind) => ({ kind, text: textOf[kind].trim() }))
    .filter((unit) => unit.text.length > 0)
    .filter(
      (unit) => unit.kind !== "sentence" || estimateSpeechMs(unit.text) <= AUTO_SENTENCE_MAX_MS,
    );
}

export function useFaceAutoAudio({
  face,
  triggerKey,
  lemma,
  sentence,
  definition,
  revealed,
  controller,
}: FaceAutoAudioInput): void {
  const { available, playSequence, stop } = controller;

  // 切卡 / 换档：按该卡面类别的编排播一次。
  useEffect(() => {
    if (!available) return;
    const config = readAutoAudioConfig();
    if (!config.master) return;
    const units = buildUnits(config.faces[face], { lemma, sentence, definition });
    if (units.length === 0) return;
    playSequence(units, config.gapMs);
    return () => stop();
  }, [available, face, triggerKey, lemma, sentence, definition, playSequence, stop]);

  // 翻卡（正 → 反）：只认 false → true 的那一刻播 `onReveal`（默认 off = 不播）。
  // 回看再翻 = 又一次揭示，可以再播；但 `revealed` 恒为真时的重渲染不重播 ——
  // 靠 ref 记住上一次揭示态，而不是把 revealed 塞进上面的依赖数组（那会让
  // 一张卡内每次翻面都连带重播整段切卡编排）。ref 初值取首帧的 revealed，
  // 因此「到达即揭示」（preview 直展）不会误触发。
  const wasRevealedRef = useRef(Boolean(revealed));
  useEffect(() => {
    const wasRevealed = wasRevealedRef.current;
    wasRevealedRef.current = Boolean(revealed);
    if (!available || !revealed || wasRevealed) return;
    const config = readAutoAudioConfig();
    if (!config.master) return;
    const units = buildUnits(config.onReveal, { lemma, sentence, definition });
    if (units.length === 0) return;
    playSequence(units, config.gapMs);
  }, [available, revealed, lemma, sentence, definition, playSequence]);
}
