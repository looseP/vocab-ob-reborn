/**
 * speech 薄封装单元测试（ADR-0036 LW-2：Web Speech API 能力检测降级）。
 * jsdom 无 speechSynthesis → speak() 返回 false（降级路径）；
 * mock speechSynthesis → speak() 正常派发 utterance。
 */

/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSpeechSynthesisAvailable, speak } from "@/frontend/reviewFlow/speech";

afterEach(() => {
  vi.restoreAllMocks();
  // 清掉测试注入的 mock
  Reflect.deleteProperty(window, "speechSynthesis");
  Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
});

describe("speak（Web Speech API 薄封装）", () => {
  it("无 speechSynthesis 环境：能力检测 false，speak 返回 false（降级跟写）", () => {
    expect(isSpeechSynthesisAvailable()).toBe(false);
    expect(speak("hello")).toBe(false);
  });

  it("有 speechSynthesis 环境：speak 派发 utterance 并返回 true", () => {
    const speakMock = vi.fn();
    const cancelMock = vi.fn();
    class FakeUtterance {
      lang = "";
      rate = 1;
      constructor(public text: string) {}
    }
    Reflect.set(window, "speechSynthesis", { speak: speakMock, cancel: cancelMock });
    Reflect.set(window, "SpeechSynthesisUtterance", FakeUtterance);

    expect(isSpeechSynthesisAvailable()).toBe(true);
    expect(speak("abound")).toBe(true);
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(speakMock).toHaveBeenCalledTimes(1);
    const utterance = speakMock.mock.calls[0][0] as InstanceType<typeof FakeUtterance>;
    expect(utterance.text).toBe("abound");
    expect(utterance.lang).toBe("en-US");
  });

  it("speechSynthesis.speak 抛异常：speak 返回 false（失败降跟写）", () => {
    Reflect.set(window, "speechSynthesis", {
      cancel: vi.fn(),
      speak: vi.fn(() => {
        throw new Error("synthesis failed");
      }),
    });
    Reflect.set(window, "SpeechSynthesisUtterance", class {
      lang = "";
      rate = 1;
      constructor(public text: string) {}
    });
    expect(speak("hello")).toBe(false);
  });
});
