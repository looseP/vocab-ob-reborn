/**
 * audioEngine —— 复习卡音频底座（Phase 1 声学底座重构）。
 *
 * 双轨发音：
 * - **主轨 / 真人高保真**：HTML5 `Audio` 播标准词典音频 CDN（详见 `wordAudioUrl`），
 *   监听 `ended` / `error`，并挂 1.5s 首帧超时。
 * - **备用轨 / 本地 TTS**：主轨创建失败、加载报错、超时或**处于离线环境**时，
 *   自动降级到 `speechSynthesis`（见 `speakFallback`）。
 *
 * 三处工程约束（都是踩过的坑，不是风格偏好）：
 * 1. **能力探测前置**：离线或环境无 mp3 解码能力（含 jsdom）时**直接**走 TTS，
 *    不浪费一次注定失败的跨域请求 —— 也让单测无需网络即可覆盖降级分支。
 * 2. **播放互斥（物理级）**：新音频一律先中断上一次 —— 真人轨 `cancel()` +
 *    `speechSynthesis.cancel()`（见 `interruptCurrent`）。只复位 UI 不 cancel，
 *    会出现"界面已复位、耳机还在念"的幽灵音轨，R / E 交替时双轨混音。
 * 3. **复位分流**：真人轨以 `Audio.onended` 为准（`WORD_REAL_AUDIO_SAFETY_MS`
 *    只是防线，不得用短文本估算腰斩 mp3）；TTS 没有可靠 `onend`，
 *    才退回 `estimateSpeechMs()` 估算复位，宁可早复位也不让 UI 卡在"播放中"。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SENTENCE_RATE,
  cancelSpeech,
  isSpeechSynthesisAvailable,
  speak,
  speakSentence,
  type Accent,
} from "@/frontend/reviewFlow/speech";
import { readAudioAccent, writeAudioAccent } from "@/frontend/utils/autoAudioSettings";

export type { Accent };

/** 音频来源：单词拼读 / 例句朗读。 */
export type AudioSource = "word" | "sentence";

/** 默认口音：美音 —— 与既有 `speak()` 的 en-US 默认保持一致。 */
export const DEFAULT_ACCENT: Accent = "us";

/** 真人音频首帧超时：超过它即降级本地 TTS（用户不该为一次加载干等）。 */
export const WORD_AUDIO_TIMEOUT_MS = 1500;

/**
 * 真人音频轨的**安全上限**（毫秒）：不是"播放时长估算"，而是"防线"。
 *
 * 真人 mp3 需要网络拉取，短词（如 `access`）用 `estimateSpeechMs` 的 600ms 下限
 * 会让定时器**腰斩**正在播放的音频 —— 声波动画提前熄灭，且 `handleRef` 被清空后
 * 连打断能力一起丢失。真人轨正常收尾一律由 `Audio.onended` 负责；
 * 这个定时器只在"既没 ended 也没 error 也没首帧超时"的极端漏网场景兜底。
 */
export const WORD_REAL_AUDIO_SAFETY_MS = 4000;

/**
 * 自动伴读的朗读单元类型：词形（双轨）/ 英文例句（TTS 优选音色）/ 中文释义（TTS）。
 */
export type AudioUnitKind = "word" | "sentence" | "definition";

export interface AudioSequenceUnit {
  kind: AudioUnitKind;
  text: string;
}

/**
 * 编排段间默认停顿（毫秒）。
 *
 * TTS 没有可靠 onend，段间必须留估算余量；留得太短两段听感粘连，太长则
 * 用户以为卡住了。350ms 是「上一段刚收尾、下一段即起」的经验值。
 */
export const DEFAULT_SEQUENCE_GAP_MS = 350;

/** 中文释义朗读的语言标签（口音 uk/us 只作用于英文轨）。 */
const DEFINITION_LANG = "zh-CN";

/**
 * 词典真人发音 CDN：type=1 英音 / type=2 美音。
 * 有道公开词典音频接口，零密钥、零依赖，覆盖考研词表常用词。
 */
export function wordAudioUrl(lemma: string, accent: Accent): string {
  const type = accent === "uk" ? 1 : 2;
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(lemma)}&type=${type}`;
}

/**
 * 播放器结构契约：只取我们真正用到的最小面。
 * 用结构类型而非 `HTMLAudioElement`，测试才能注入 fake 精确驱动
 * `ended` / `error` / 超时三种收尾路径。
 */
export interface WordAudioElement {
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play: () => Promise<void> | void;
  pause: () => void;
}

export type AudioElementFactory = (url: string) => WordAudioElement;

const defaultAudioFactory: AudioElementFactory = (url) => {
  const Ctor = (window as unknown as { Audio: new (src?: string) => WordAudioElement }).Audio;
  return new Ctor(url);
};

/** 环境是否具备 HTML5 音频解码能力（jsdom / 无 mp3 解码器的运行环境 → false）。 */
export function isRealAudioSupported(): boolean {
  if (typeof window === "undefined") return false;
  const Ctor = (
    window as unknown as { Audio?: new (src?: string) => { canPlayType?: (type: string) => string } }
  ).Audio;
  if (typeof Ctor !== "function") return false;
  try {
    const probe = new Ctor();
    if (typeof probe.canPlayType !== "function") return false;
    return probe.canPlayType("audio/mpeg") !== "";
  } catch {
    return false;
  }
}

/** 离线检测（`navigator.onLine === false` 才认为离线；缺失按在线处理）。 */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** 主轨可用性 = 有解码能力 + 在线。 */
export function canPlayRealAudio(): boolean {
  return isRealAudioSupported() && !isOffline();
}

export interface WordAudioHooks {
  /** 主轨失败、已成功降级到本地 TTS。 */
  onFallback?: () => void;
  /** 整段播放收尾（自然播完 / 被取消）。降级时 TTS 仍在发声，故不触发。 */
  onEnd?: () => void;
}

export interface AudioHandle {
  cancel: () => void;
}

const NOOP_HANDLE: AudioHandle = { cancel: () => undefined };

/**
 * 单词发音的备用轨（本地 TTS）。
 *
 * US 走既有 `speak()`：默认 lang 即 en-US，**保持"单参数调用"的既有契约**
 * （review-card-audio 测试锁定了 `speak(text)` 的入参形状）。
 * UK 需要 en-GB —— 单参数的 `speak()` 表达不了，故走 `speakSentence()` 的音色优选路径。
 */
function speakFallback(text: string, accent: Accent): void {
  if (accent === "uk") speakSentence(text, { accent: "uk" });
  else speak(text);
}

/** 主轨驱动：`ended` 正常收尾，`error` / 超时 / play() reject 降级。 */
function playRealAudioTrack(
  text: string,
  accent: Accent,
  hooks: WordAudioHooks,
  factory: AudioElementFactory,
): AudioHandle {
  let element: WordAudioElement;
  try {
    element = factory(wordAudioUrl(text, accent));
  } catch {
    hooks.onFallback?.();
    speakFallback(text, accent);
    return NOOP_HANDLE;
  }

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    element.onended = null;
    element.onerror = null;
  };
  const stopElement = () => {
    try {
      element.pause();
    } catch {
      // 无头环境未实现 pause；生产端此处失败也无副作用（已在收尾）
    }
  };
  const finish = (fellBack: boolean) => {
    if (settled) return;
    settled = true;
    cleanup();
    stopElement();
    if (fellBack) {
      hooks.onFallback?.();
      // 降级后音频仍在发声（TTS）——不调 onEnd，由调用方的估算定时器收尾
      speakFallback(text, accent);
    } else {
      hooks.onEnd?.();
    }
  };

  element.onended = () => finish(false);
  element.onerror = () => finish(true);
  timer = setTimeout(() => finish(true), WORD_AUDIO_TIMEOUT_MS);

  try {
    const playing = element.play();
    if (playing && typeof playing.then === "function") {
      // 自动播放策略 / 跨域失败时 play() 走 reject 而非 error 事件
      playing.then(undefined, () => finish(true));
    }
  } catch {
    finish(true);
  }

  return { cancel: () => finish(false) };
}

/**
 * 播放单词发音：优先真人音频，失败/超时/离线降级本地 TTS。
 *
 * `audioFactory` 仅供测试注入（注入即强制走主轨，便于精确驱动三种收尾）。
 */
export function playWordAudio(
  lemma: string,
  accent: Accent,
  hooks: WordAudioHooks = {},
  audioFactory?: AudioElementFactory,
): AudioHandle {
  const text = (lemma ?? "").trim();
  if (text.length === 0) return NOOP_HANDLE;
  if (audioFactory !== undefined || canPlayRealAudio()) {
    return playRealAudioTrack(text, accent, hooks, audioFactory ?? defaultAudioFactory);
  }
  speakFallback(text, accent);
  return NOOP_HANDLE;
}

/**
 * TTS 时长估算（毫秒）：`speak()` / `speakSentence()` 只回 boolean，
 * 没有可靠的 ended 回调，用文本长度估算复位"播放中"状态。
 */
export function estimateSpeechMs(text: string): number {
  const chars = text.trim().length;
  if (chars === 0) return 0;
  return Math.min(60_000, Math.max(600, Math.round(chars * 70)));
}

export interface AudioController {
  /** 环境是否具备任意一条发声路径（真人音频或 TTS）。 */
  available: boolean;
  isPlaying: boolean;
  currentSource: AudioSource | null;
  accent: Accent;
  toggleAccent: () => void;
  playWord: (lemma: string) => void;
  playSentence: (text: string) => void;
  /**
   * 自动伴读：按编排顺序朗读一串单元（词 → 停顿 → 例句 → 停顿 → 释义）。
   *
   * 与 playWord / playSentence 同一套互斥与收尾机制：起播即打断在途音频
   * （含上一套未播完的编排），用户随后任何手动播放也会连带取消本编排。
   */
  playSequence: (units: readonly AudioSequenceUnit[], gapMs?: number) => void;
  stop: () => void;
}

/**
 * 统一音频控制器：防抖 / 互斥 / 响应式状态。
 *
 * 状态为**乐观置位**（发令即进入播放态 + 估算定时器收尾），因为两条轨都不保证
 * 回传精确的结束时刻；乐观置位换来的是 UI（声波动画、按钮高亮）永不卡死。
 */
export function useAudioController(): AudioController {
  // 口音从本地偏好恢复：自动伴读每次挂载都新建控制器，不持久化就意味着
  // 用户切一次英音、换一张卡就被打回美音 —— 伴读场景下这个缺口会被放大。
  const [accent, setAccent] = useState<Accent>(() => readAudioAccent() ?? DEFAULT_ACCENT);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSource, setCurrentSource] = useState<AudioSource | null>(null);

  // 回调用 ref 读口音：避免每次切换口音都重建键盘监听（ReviewCardView 的 keydown 依赖它）
  const accentRef = useRef(accent);
  accentRef.current = accent;

  const handleRef = useRef<AudioHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  /**
   * 在途自动编排的取消句柄。
   *
   * 编排是「定时器链」，取消必须**同时**做两件事：清掉挂起的下一段定时器 +
   * 置位 cancelled（否则链上后续 step 会把已停的声音重新唤起）。
   */
  const sequenceRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; cancelled: boolean } | null>(null);

  const cancelSequence = useCallback(() => {
    const seq = sequenceRef.current;
    sequenceRef.current = null;
    if (!seq) return;
    seq.cancelled = true;
    if (seq.timer !== null) clearTimeout(seq.timer);
    seq.timer = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const finishPlayback = useCallback(() => {
    if (!aliveRef.current) return;
    clearTimer();
    handleRef.current = null;
    setIsPlaying(false);
    setCurrentSource(null);
  }, [clearTimer]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelSequence();
      clearTimer();
      handleRef.current?.cancel();
      handleRef.current = null;
      // 卸载兜底：句柄只覆盖"已知在途对象"，TTS 在极端时序下可能已脱离句柄，
      // 直接对 speechSynthesis 发一次物理 cancel，避免离开页面后耳机还在念。
      cancelSpeech();
    };
  }, [cancelSequence, clearTimer]);

  /**
   * 中断在途音频并清定时器，但**不改**播放态（由随后的 begin 接管）。
   *
   * `cancelSpeech()` 不可省略：`handleRef.current?.cancel()` 只停我们自己创建的对象，
   * Web Speech 已排队的整句必须靠 `speechSynthesis.cancel()` 才能真停 ——
   * 否则 UI 复位了、耳机里仍在念，随后按 R 会与单词发音双轨混音。
   *
   * `cancelSequence()` 同样不可省：用户手动播放 = 用户要听别的，在途自动编排
   * 必须整条作废（只清当前段的话，下一段定时器会把声音重新唤起）。
   */
  const interruptCurrent = useCallback(() => {
    cancelSequence();
    handleRef.current?.cancel();
    handleRef.current = null;
    cancelSpeech();
    clearTimer();
  }, [cancelSequence, clearTimer]);

  const begin = useCallback(
    (source: AudioSource, estimatedMs: number) => {
      clearTimer();
      setIsPlaying(true);
      setCurrentSource(source);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        finishPlayback();
      }, estimatedMs);
    },
    [clearTimer, finishPlayback],
  );

  const playWord = useCallback(
    (lemma: string) => {
      const text = lemma.trim();
      if (text.length === 0) return;
      interruptCurrent();
      // 真人轨：用 4s 安全上限兜底（正常收尾走 Audio.onended），**绝不用 600ms 腰斩**；
      // 纯 TTS 路径（离线 / 无 mp3 解码能力）没有 onended，仍按文本长度估算复位。
      const realTrack = canPlayRealAudio();
      begin(
        "word",
        realTrack ? Math.max(WORD_REAL_AUDIO_SAFETY_MS, estimateSpeechMs(text)) : estimateSpeechMs(text),
      );
      handleRef.current = playWordAudio(text, accentRef.current, {
        onEnd: finishPlayback,
        onFallback: () => {
          // 主轨已失败（error / 超时 / play reject）而声音真的切换到了 TTS：
          // 此时才启用按字符数估算的短定时器，接管 TTS 的状态复位。
          clearTimer();
          timerRef.current = setTimeout(finishPlayback, estimateSpeechMs(text));
        },
      });
    },
    [begin, clearTimer, finishPlayback, interruptCurrent],
  );

  const playSentence = useCallback(
    (text: string) => {
      const content = text.trim();
      if (content.length === 0) return;
      interruptCurrent();
      begin("sentence", estimateSpeechMs(content));
      const started = speakSentence(content, { accent: accentRef.current, rate: SENTENCE_RATE });
      if (started) {
        // **必须挂上物理打断句柄**：TTS 没有可用的 ended 回传，句柄是上游
        // （E 再按一次 / 按 R / 组件卸载）唯一能真正掐断这条长句的入口。
        handleRef.current = { cancel: cancelSpeech };
      } else {
        // 无 TTS 能力时不留在"播放中"假状态
        finishPlayback();
      }
    },
    [begin, finishPlayback, interruptCurrent],
  );

  const stop = useCallback(() => {
    interruptCurrent();
    finishPlayback();
  }, [interruptCurrent, finishPlayback]);

  /**
   * 自动编排播放器（切卡伴读的核心）。
   *
   * 逐段推进：`词（双轨）→ 停顿 → 例句（TTS）→ 停顿 → 释义（TTS zh-CN）`。
   * 段间用估算时长兜底（TTS 无可靠 onend），词形真人轨则按 `onended` 精确
   * 衔接、降级时才退回估算。每段起播前 `begin()` 乐观置位播放态，让卡面
   * 声学胶囊的动画与自动播报同步。
   *
   * 空文本单元在入口即被剔除 —— stub 词（无例句/无释义）自动降级成短编排，
   * 不需要调用方逐个判空。
   */
  const playSequence = useCallback(
    (units: readonly AudioSequenceUnit[], gapMs: number = DEFAULT_SEQUENCE_GAP_MS) => {
      const items = units
        .map((unit) => ({ kind: unit.kind, text: (unit.text ?? "").trim() }))
        .filter((unit) => unit.text.length > 0);
      if (items.length === 0) return;

      cancelSequence();
      interruptCurrent();

      const seq: { timer: ReturnType<typeof setTimeout> | null; cancelled: boolean } = {
        timer: null,
        cancelled: false,
      };
      sequenceRef.current = seq;

      const step = (index: number) => {
        if (seq.cancelled) return;
        if (index >= items.length) {
          sequenceRef.current = null;
          finishPlayback();
          return;
        }
        const unit = items[index];
        const advance = (delayMs: number) => {
          if (seq.cancelled) return;
          seq.timer = setTimeout(() => {
            seq.timer = null;
            step(index + 1);
          }, delayMs);
        };
        // 播放态乐观置位：definition 归入 sentence 类（声学胶囊只区分词/句两种动画）
        begin(unit.kind === "word" ? "word" : "sentence", estimateSpeechMs(unit.text));
        if (unit.kind === "word") {
          if (canPlayRealAudio()) {
            handleRef.current = playWordAudio(unit.text, accentRef.current, {
              onEnd: () => advance(gapMs),
              onFallback: () => advance(estimateSpeechMs(unit.text) + gapMs),
            });
          } else {
            // 无真人轨能力（离线 / 无 mp3 解码）：直接 TTS，按估算衔接下一段
            speakFallback(unit.text, accentRef.current);
            advance(estimateSpeechMs(unit.text) + gapMs);
          }
          return;
        }
        if (unit.kind === "sentence") {
          const started = speakSentence(unit.text, { accent: accentRef.current, rate: SENTENCE_RATE });
          handleRef.current = { cancel: cancelSpeech };
          advance((started ? estimateSpeechMs(unit.text) : 0) + gapMs);
          return;
        }
        const started = speak(unit.text, DEFINITION_LANG);
        handleRef.current = { cancel: cancelSpeech };
        advance((started ? estimateSpeechMs(unit.text) : 0) + gapMs);
      };

      step(0);
    },
    [begin, cancelSequence, finishPlayback, interruptCurrent],
  );

  const toggleAccent = useCallback(() => {
    setAccent((prev) => {
      const next = prev === "uk" ? "us" : "uk";
      writeAudioAccent(next);
      return next;
    });
  }, []);

  // 能力探测结果在本挂载周期内不变，不必每次渲染重算
  const available = useMemo(() => isRealAudioSupported() || isSpeechSynthesisAvailable(), []);

  return {
    available,
    isPlaying,
    currentSource,
    accent,
    toggleAccent,
    playWord,
    playSentence,
    playSequence,
    stop,
  };
}
