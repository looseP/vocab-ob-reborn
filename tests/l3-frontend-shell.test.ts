import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createBrowserL3Client } from "@/frontend/api/l3Client";

describe("Phase 4B L3 frontend shell", () => {
  it("creates the browser L3 client through the shared contract adapter", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [], limit: 20, cursor: null, nextCursor: null }),
      input,
      init,
    })) as unknown as typeof fetch;

    const client = createBrowserL3Client("/backend", fetchImpl);
    const result = await client.listProposals({ status: "pending", limit: 20 });

    expect(result.items).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith("/backend/api/l3/proposals?status=pending&limit=20", expect.objectContaining({
      method: "GET",
    }));
  });

  it("keeps frontend shell imports away from server-only layers", () => {
    const files = [
      "src/frontend/App.tsx",
      "src/frontend/api/l3Client.ts",
      "src/frontend/components/L3ErrorMessage.tsx",
      "src/frontend/components/L3Shell.tsx",
      "src/frontend/pages/L3HomePage.tsx",
      "src/frontend/pages/L3ImportPage.tsx",
      "src/frontend/pages/L3ProposalPage.tsx",
      "src/frontend/pages/L3RecommendationPage.tsx",
      "src/frontend/pages/L3GraphPage.tsx",
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/@\/(?:db|repositories|services|http)\//);
      expect(source).not.toMatch(/@\/server/);
      expect(source).not.toMatch(/from ["'](?:node:)?(?:fs|path|crypto|process)["']/);
    }
  });

  it("keeps Phase 4C pages on the shared frontend client instead of local fetch calls", () => {
    const files = [
      "src/frontend/pages/L3ImportPage.tsx",
      "src/frontend/pages/L3ProposalPage.tsx",
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/XMLHttpRequest/);
      expect(source).toMatch(/L3FrontendClient|client\./);
    }
  });
});
