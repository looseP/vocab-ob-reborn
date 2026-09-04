import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/connection", () => ({
  getPool: vi.fn(),
}));

import { getPool } from "@/db/connection";
import { loadWordbookWeights } from "@/db/weights-loader";

describe("loadWordbookWeights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns weights array when settings has valid fsrs_weights", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{
        weights: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61, 0.0, 0.0],
      }],
    });
    vi.mocked(getPool).mockReturnValue({ query: mockQuery } as any);

    const result = await loadWordbookWeights("wordbook-uuid-1");
    expect(result).toHaveLength(19);
    expect(result?.[0]).toBe(0.4);
  });

  it("returns null when wordbook not found", async () => {
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    const result = await loadWordbookWeights("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when weights array too short (< 17)", async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [{ weights: [0.4, 0.6] }] }),
    } as any);
    const result = await loadWordbookWeights("wordbook-1");
    expect(result).toBeNull();
  });

  it("returns null on DB error (graceful fallback)", async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error("Connection refused")),
    } as any);
    const result = await loadWordbookWeights("wordbook-1");
    expect(result).toBeNull();
  });
});
