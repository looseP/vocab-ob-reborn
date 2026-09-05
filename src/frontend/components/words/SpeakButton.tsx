import { useState } from "react";
import { Volume2 } from "lucide-react";

/**
 * Web Speech API 朗读按钮（零依赖 TTS）。
 * 浏览器不支持（含 jsdom 测试环境）时渲染 null。
 */
export function SpeakButton({ text, label }: { text: string; label?: string }) {
  const [speaking, setSpeaking] = useState(false);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  if (!supported) return null;

  const speak = () => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 0.95;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  };

  return (
    <button
      type="button"
      onClick={speak}
      aria-label={label ?? `朗读 ${text}`}
      title={speaking ? "朗读中…" : "朗读发音"}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors ${
        speaking
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-[var(--color-border)] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      }`}
    >
      <Volume2 className="h-4 w-4" />
    </button>
  );
}
