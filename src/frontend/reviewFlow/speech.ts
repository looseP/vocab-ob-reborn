/**
 * speech —— Web Speech API 薄封装（ADR-0036 决策 5：零新依赖，能力检测降级）。
 *
 * speak()：TTS 朗读；无 speechSynthesis / 实例化失败 / 合成异常一律返回 false，
 * 调用方降级（听写强化 → 跟写）。isSpeechSynthesisAvailable() 供 UI 隐藏按钮。
 */

export function isSpeechSynthesisAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function speak(text: string, lang = "en-US"): boolean {
  if (!isSpeechSynthesisAvailable()) return false;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}
