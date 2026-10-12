/**
 * useFaceAutoAudio —— 切卡自动伴读钩子（2026-10-12）。
 *
 * 卡面挂载（或 `triggerKey` 变化 = 换卡/换档）时，按该卡面类别的编排
 * **自动朗读一次**；卸载或再次触发前先掐断上一段（不留幽灵音轨）。
 *
 * 六条设计约束（都来自实测过的坑，不是风格偏好）：
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
 * 5. **一屏多卡的卡面不接「到达」**：葫芦冲刺一次把整页 20 张卡同时挂出来，
 *    没有「当前卡」——到达时逐卡朗读会变成齐声混响。这类卡面**不传 `face`**，
 *    只保留用户主动翻开某一张时的 `onReveal`（默认 off）。
 * 6. **一次卡面里，一个词只响一次**：卡面首帧常常只有词形（释义 / 例句要等
 *    异步详情回来）。旧写法把内容字段直接放进依赖，详情一到就掐断整段重播 ——
 *    用户听到同一个词读第二遍。改为**同一 `triggerKey` 内按单元去重**：新到的
 *    单元补播，播过的一个都不再重复；且补播会**等当前这段念完**（`isPlaying`）
 *    再接上，既不打断也不重念。掐断只发生在换卡 / 换档。
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
  /**
   * 卡面类别（决定**到达时**读哪套编排）。
   *
   * 不传 = 该卡面没有「到达」语义，只接翻卡（见文件头第 5 条）——一屏多卡的
   * 葫芦冲刺是唯一这类卡面。`revealed` 不受影响，照常驱动 `onReveal`。
   */
  face?: FaceClass;
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
  /**
   * 卡面音频控制器：取其稳定方法与可用性。
   *
   * 需要 `isPlaying` 是为了**不打断**在途播报：晚到的释义 / 例句不能靠
   * `playSequence` 硬切（它起播即打断），得等当前这段念完再接上。
   */
  controller: Pick<AudioController, "available" | "isPlaying" | "playSequence" | "stop">;
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

/**
 * 单元身份：`kind:text`。
 *
 * 用在「同一 triggerKey 内去重」上 —— 同一个词（或同一句话）在一次卡面里只响一次，
 * 晚到的释义 / 例句按这个身份判「是不是新东西」。
 */
function unitKey(unit: AudioSequenceUnit): string {
  return `${unit.kind}:${unit.text}`;
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
  const { available, isPlaying, playSequence, stop } = controller;

  /**
   * 本次 `triggerKey` 内**已经播过**的单元（按 `unitKey` 记）。
   *
   * 卡面首帧常常只有词形，释义 / 例句要等异步详情回来才算齐。若把内容字段留在
   * 依赖里（旧写法），详情一到就会掐断整段重播 —— 用户听到同一个词读第二遍。
   * 改成「同一 triggerKey 内按单元去重」：新到的单元补播，播过的绝不重复。
   */
  const playedRef = useRef<{ key: string; played: Set<string> }>({
    key: "",
    played: new Set<string>(),
  });
  /** 攒着等补播的新单元：正在念东西时不打断，念完再接上。 */
  const pendingRef = useRef<{ units: AudioSequenceUnit[]; gapMs: number } | null>(null);

  // 切卡 / 换档：按该卡面类别的编排播一次。没有 `face` 的卡面（一屏多卡）
  // 整段跳过 —— 它只在翻卡那一刻发声。
  useEffect(() => {
    if (!face || !available) return;
    const config = readAutoAudioConfig();
    if (!config.master) return;
    const units = buildUnits(config.faces[face], { lemma, sentence, definition });
    if (units.length === 0) return;

    if (playedRef.current.key !== triggerKey) {
      // 换卡 / 换档：新的一轮 —— 去重表清空，上一张卡没来得及补播的也一起丢掉。
      playedRef.current = { key: triggerKey, played: new Set<string>() };
      pendingRef.current = null;
    }
    const fresh = units.filter((unit) => !playedRef.current.played.has(unitKey(unit)));
    if (fresh.length === 0) return;
    for (const unit of fresh) playedRef.current.played.add(unitKey(unit));

    if (isPlaying) {
      // 正在念（多半是首帧那次的词）：不打断，攒起来等它念完再接。
      pendingRef.current = {
        units: [...(pendingRef.current?.units ?? []), ...fresh],
        gapMs: config.gapMs,
      };
      return;
    }
    playSequence(fresh, config.gapMs);
  }, [available, face, triggerKey, lemma, sentence, definition, isPlaying, playSequence]);

  // 在途播报念完：把攒下的新单元接上（已播过的单元不在里面，同一个词不会重念）。
  useEffect(() => {
    const pending = pendingRef.current;
    if (isPlaying || !pending) return;
    pendingRef.current = null;
    playSequence(pending.units, pending.gapMs);
  }, [isPlaying, playSequence]);

  // 掐断在途播报只跟「换卡 / 换档」走：内容补播不该打断已经在念的句子，所以这条
  // 清理独立挂在 triggerKey 上（卸载时同样生效）。
  useEffect(() => () => stop(), [triggerKey, stop]);

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
