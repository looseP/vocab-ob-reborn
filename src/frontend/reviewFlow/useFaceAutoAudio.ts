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
 *
 * 依赖数组只收**稳定引用**（控制器的方法是 useCallback，available 是
 * useMemo）与原始值 —— 控制器对象本身每次渲染都是新身份，不能进依赖。
 */

import { useEffect } from "react";
import type { AudioController, AudioSequenceUnit } from "@/frontend/reviewFlow/audioEngine";
import { readAutoAudioConfig, type FaceClass } from "@/frontend/utils/autoAudioSettings";

export interface FaceAutoAudioInput {
  /** 卡面类别（决定读哪套编排）。 */
  face: FaceClass;
  /** 重触发键：换卡/换档即变（progressId、tier…）。 */
  triggerKey: string;
  lemma?: string | null;
  sentence?: string | null;
  definition?: string | null;
  /** 卡面音频控制器：取其稳定方法与可用性。 */
  controller: Pick<AudioController, "available" | "playSequence" | "stop">;
}

/** 按编排组装朗读单元；空文本的单元直接剔除（stub 词自动降级）。 */
function buildUnits(
  playlist: readonly ("word" | "sentence" | "definition")[],
  source: { lemma?: string | null; sentence?: string | null; definition?: string | null },
): AudioSequenceUnit[] {
  const textOf = {
    word: source.lemma ?? "",
    sentence: source.sentence ?? "",
    definition: source.definition ?? "",
  } as const;
  return playlist
    .map((kind) => ({ kind, text: textOf[kind].trim() }))
    .filter((unit) => unit.text.length > 0);
}

export function useFaceAutoAudio({
  face,
  triggerKey,
  lemma,
  sentence,
  definition,
  controller,
}: FaceAutoAudioInput): void {
  const { available, playSequence, stop } = controller;

  useEffect(() => {
    if (!available) return;
    const config = readAutoAudioConfig();
    if (!config.master) return;
    const playlist = config.faces[face];
    if (playlist === "off") return;
    const units = buildUnits(playlist, { lemma, sentence, definition });
    if (units.length === 0) return;
    playSequence(units, config.gapMs);
    return () => stop();
  }, [available, face, triggerKey, lemma, sentence, definition, playSequence, stop]);
}
