/**
 * speech —— Web Speech API 封装（ADR-0036 决策 5：零新依赖，能力检测降级）。
 *
 * 底层职责只有三件：
 * 1. `speak()`：单词/短文本 TTS。无 speechSynthesis / 实例化失败 / 合成异常一律
 *    返回 false，调用方降级（听写强化 → 跟写）。`isSpeechSynthesisAvailable()`
 *    供 UI 隐藏按钮。
 * 2. `speakSentence()` + `pickEnglishVoice()`：**长句朗读的自然语音优选**
 *    （Natural / Online / Neural / Google / Apple 等优质英语人声，退化任意 en 语音），
 *    以及口音感知（en-GB / en-US）与语速配置。
 * 3. `cancelSpeech()`：**物理**停声（`speechSynthesis.cancel()`），供上层打断/卸载调用。
 *    只复位 UI 状态而不 cancel 会留下"界面已复位、耳机还在念"的幽灵音轨。
 *
 * 契约稳定性：`speak(text, lang = "en-US")` 的签名与默认值**不得改动** ——
 * review-card-audio 测试与 `FollowCopyView` 都依赖「单参数调用即 en-US」这一行为，
 * 降级路径悄悄加上第二个实参会同时打断两边。
 */

/** 口音取向：uk = 英音（en-GB），us = 美音（en-US）。 */
export type Accent = "uk" | "us";

/** 口音 → BCP-47 语言标签。 */
export const ACCENT_LANG: Record<Accent, string> = { uk: "en-GB", us: "en-US" };

/** 例句朗读推荐语速：0.9 比单词默认更慢，长句更清晰（精读/听写复核口径）。 */
export const SENTENCE_RATE = 0.9;

export function isSpeechSynthesisAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * 在途 utterance 的**模块级强引用**（防 GC）。
 *
 * Chromium 的 V8 会回收"没有任何 JS 引用"的 `SpeechSynthesisUtterance`，
 * 即便它仍在朗读队列里 —— 表现是长句念到一半突然静音。持引用到
 * `onend` / `onerror` / `cancelSpeech()` 才释放。
 */
let activeUtterance: SpeechSynthesisUtterance | null = null;

/**
 * **物理**打断：掐断 Web Speech 正在发声（含已排队的整句）。
 *
 * 为什么必须单独导出：`speechSynthesis.cancel()` 是唯一能真正停声的入口。
 * 只复位 UI 状态而不 cancel，会出现"界面已复位、耳机里还在念完整句"的幽灵音轨，
 * 且随后按 R 听单词会与它**双轨混音**。清引用与取消必须原子完成。
 */
export function cancelSpeech(): void {
  activeUtterance = null;
  if (!isSpeechSynthesisAvailable()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // 无头环境未实现 / 引擎异常：打断失败无副作用（调用方只要"尽力停"）
  }
}

/** 收尾时释放强引用 —— 比较身份而非无条件置空：新 utterance 可能已接管该变量。 */
function releaseUtterance(utterance: SpeechSynthesisUtterance): void {
  if (activeUtterance === utterance) activeUtterance = null;
}

/** 为 utterance 挂上"收尾即释放引用"的钩子（onend / onerror 两条路径）。 */
function trackUtterance(utterance: SpeechSynthesisUtterance): void {
  activeUtterance = utterance;
  utterance.onend = () => releaseUtterance(utterance);
  utterance.onerror = () => releaseUtterance(utterance);
}

export function speak(text: string, lang = "en-US"): boolean {
  if (!isSpeechSynthesisAvailable()) return false;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9;
    trackUtterance(utterance);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

/**
 * 自然语音关键词：Chromium/Edge 的 "Natural / Online / Neural" 音色，
 * 以及各平台的 premium / enhanced 音色包 —— 这些是真正"像人"的那一档。
 */
const NATURAL_VOICE_HINTS = ["natural", "online", "neural", "premium", "enhanced", "siri"];

/**
 * 厂商标识：即便没有 Natural 后缀，Google / Microsoft / Apple 的系统英语人声
 * 也普遍优于第三方合成器。
 */
const VENDOR_VOICE_HINTS = [
  "google",
  "microsoft",
  "apple",
  "samantha",
  "daniel",
  "serena",
  "karen",
  "moira",
  "alex",
];

/**
 * 音色分档：**口音匹配优先于一切**，档内再比自然度。
 *
 * 为什么必须是分档而不是加权求和：加权会出现「US 的 Natural 音色分数高于
 * UK 的普通音色」，于是切到英音却仍在念美音 —— 口音开关就成了摆设。
 * 分档保证：有对口音的音色时绝不跨口音选；没有时才退让（见 tier 0 / -1）。
 *
 * tier 3：对口音 + 自然语音（Natural / Online / Neural …）
 * tier 2：对口音 + 厂商优质人声
 * tier 1：对口音（任意英语音色）
 * tier 0：口音不符，但本身是自然语音 / 厂商人声
 * tier -1：口音不符的其它英语音色
 */
function voiceTier(voice: SpeechSynthesisVoice, lang: string): number {
  const name = (voice.name ?? "").toLowerCase();
  const voiceLang = (voice.lang ?? "").toLowerCase().replace("_", "-");
  // 大小写必须归一：`ACCENT_LANG` 是人读的 "en-GB"，音色表里是 "en-GB"/"en-gb" 混杂，
  // 直接 startsWith 会**恒为 false**，口音优先级静默失效（切英音仍在念美音）。
  const targetLang = lang.toLowerCase().replace("_", "-");
  const matchesAccent = voiceLang.startsWith(targetLang);
  const natural = NATURAL_VOICE_HINTS.some((hint) => name.includes(hint));
  const vendor = VENDOR_VOICE_HINTS.some((hint) => name.includes(hint));
  if (matchesAccent) {
    if (natural) return 3;
    if (vendor) return 2;
    return 1;
  }
  if (natural || vendor) return 0;
  return -1;
}

/**
 * 音色打分 = 档位 × 10 + 云端加成。云端音色（`localService === false`）通常比
 * 本地合成自然，但**只在同档内**作为加分项，不跨档翻盘。
 */
function scoreVoice(voice: SpeechSynthesisVoice, lang: string): number {
  return voiceTier(voice, lang) * 10 + (voice.localService === false ? 1 : 0);
}

/**
 * 在可用音色表里挑一条英语人声：先按口音，退化到任意 en 语音；
 * 无任何英语音色时返回 null（调用方保留 utterance.lang，让引擎自选）。
 */
export function pickEnglishVoice(
  voices: readonly SpeechSynthesisVoice[] | null | undefined,
  accent: Accent = "us",
): SpeechSynthesisVoice | null {
  const lang = ACCENT_LANG[accent];
  const english = (voices ?? []).filter((voice) => (voice.lang ?? "").toLowerCase().startsWith("en"));
  if (english.length === 0) return null;
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -1;
  for (const voice of english) {
    const score = scoreVoice(voice, lang);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

/** 音色表读取：`getVoices()` 在无头环境/音色未加载时可能缺失或抛错 → 空表。 */
function readVoices(): SpeechSynthesisVoice[] {
  try {
    const list = window.speechSynthesis?.getVoices?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export interface SentenceSpeechOptions {
  accent?: Accent;
  rate?: number;
}

/**
 * 长句朗读（例句原声）：自然语音优选 + 口音感知 + 可配语速。
 *
 * 与前一次朗读互斥（先 `cancel()`）——复习卡上 R 与 E 会交替触发，
 * 不 cancel 会出现两条语音叠着念。
 */
export function speakSentence(text: string, options: SentenceSpeechOptions = {}): boolean {
  if (!isSpeechSynthesisAvailable()) return false;
  const { accent = "us", rate = SENTENCE_RATE } = options;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.lang = ACCENT_LANG[accent];
    const voice = pickEnglishVoice(readVoices(), accent);
    if (voice) {
      utterance.voice = voice;
      // 退化音色的 lang 可能与请求口音不同（如无 en-GB 时选到 en-US），
      // 以实际音色为准，避免引擎在 lang 与 voice 冲突时静默不发声。
      if (voice.lang) utterance.lang = voice.lang;
    }
    // 长句是被 V8 GC 截断的高危场景（朗读时长本身就长）——必须持强引用
    trackUtterance(utterance);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}
