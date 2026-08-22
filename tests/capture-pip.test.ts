/// <reference lib="dom" />
// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";

const getBrowserSession = vi.fn();
vi.mock("@/frontend/api/browserAuth", () => ({
  getBrowserSession: (...args: unknown[]) => getBrowserSession(...args),
}));

const { supportsDocumentPiP, launchCaptureWindow } = await import(
  "@/frontend/hooks/useCaptureFloatingWindow"
);

describe("supportsDocumentPiP", () => {
  it("returns false when the API is absent (jsdom / Firefox / Safari)", () => {
    expect(supportsDocumentPiP(window)).toBe(false);
  });

  it("returns true when documentPictureInPicture is present", () => {
    const fake = { documentPictureInPicture: { requestWindow: async () => window } } as unknown as Window;
    expect(supportsDocumentPiP(fake)).toBe(true);
  });

  it("returns false when the property exists but is null", () => {
    const fake = { documentPictureInPicture: null } as unknown as Window;
    expect(supportsDocumentPiP(fake)).toBe(false);
  });
});

describe("useCaptureFloatingWindow — popup fallback robustness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBrowserSession.mockResolvedValue({ role: "owner" });
  });

  it("reports popup-blocked when window.open returns null", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const launch = launchCaptureWindow;
    const result = await launch();
    expect(result).toBe("popup-blocked");
    openSpy.mockRestore();
  });

  it("degrades to the popup when requestWindow rejects", async () => {
    const requestWindow = vi.fn(async () => {
      throw new Error("InvalidStateError");
    });
    const openSpy = vi.fn(() => window);
    const fake = {
      documentPictureInPicture: { requestWindow },
      open: openSpy,
    } as unknown as Window;
    const originalWindow = globalThis.window;
    // launchCaptureWindow reads supportsDocumentPiP(window) AND window.open —
    // both must come from the fake while it is swapped in.
    Object.defineProperty(globalThis, "window", { value: fake, configurable: true, writable: true });
    try {
      const result = await launchCaptureWindow();
      expect(result).toBe("popup");
      expect(requestWindow).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true, writable: true });
    }
  });
});

