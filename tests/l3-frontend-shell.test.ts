import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createBrowserL3Client } from "@/frontend/api/l3Client";
import { formatL3ErrorDetails } from "@/frontend/viewModels/l3ErrorViewModel";
import { buildRawTextImportPayload, summarizeImportProposalItem } from "@/frontend/viewModels/l3ImportViewModel";
import { sortProposalItems, summarizeProposalItem } from "@/frontend/viewModels/l3ProposalViewModel";
import { normalizeL3Error } from "@/l3/frontend/contract";
import type { L3ProposalItemRow } from "@/domain";

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
      expect(source).not.toContain("/api/l3/");
      expect(source).toMatch(/L3FrontendClient|client\./);
    }
  });

  it("builds raw import payloads only after explicit local field validation", () => {
    let caught: unknown;
    try {
      buildRawTextImportPayload({
        sourceTitle: " ",
        sourceType: "manual",
        sourceLanguage: "en",
        wordbookId: " ",
        text: " ",
        targetWords: "vivid",
        contextType: "sentence",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      status: 400,
      fieldErrors: {
        "source.title": ["source.title cannot be empty."],
        text: ["text cannot be empty."],
      },
    });

    const payload = buildRawTextImportPayload({
      sourceTitle: "  Manual note  ",
      sourceType: "manual",
      sourceLanguage: " en ",
      wordbookId: " wb-1 ",
      text: "A vivid sentence.",
      targetWords: " vivid,\nVIVID,, lucid ",
      contextType: "sentence",
    });

    expect(payload).toMatchObject({
      wordbookId: "wb-1",
      source: { sourceType: "manual", title: "Manual note", language: "en" },
      targetWords: [{ slug: "vivid" }, { slug: "lucid" }],
      options: { contextType: "sentence" },
    });
  });

  it("summarizes import and proposal items without relying on raw JSON dumps", () => {
    const contextItem = proposalItem({
      id: "item-2",
      item_type: "context",
      ordinal: 2,
      payload: { contextType: "sentence", text: "A long but readable context." },
    });
    const occurrenceItem = proposalItem({
      id: "item-1",
      item_type: "occurrence",
      ordinal: 1,
      payload: { slug: "vivid", surface: "vivid", startOffset: 2, endOffset: 7 },
    });

    expect(sortProposalItems([contextItem, occurrenceItem]).map((item: L3ProposalItemRow) => item.ordinal)).toEqual([1, 2]);
    expect(summarizeProposalItem(occurrenceItem)).toBe("vivid: vivid [2-7]");
    expect(summarizeProposalItem(contextItem)).toBe("A long but readable context.");
    expect(summarizeImportProposalItem({ item_type: "context_link", ordinal: 3, payload: { linkType: "illustrates", targetType: "word" } }, 0))
      .toBe("#3 context_link: illustrates -> word");
  });

  it("formats normalized error details without leaking object display strings", () => {
    const error = normalizeL3Error(409, {
      code: "CONFLICT",
      message: "State changed. Refresh and retry.",
      details: { currentStatus: "confirmed" },
    });
    const validation = normalizeL3Error(422, {
      message: "Validation failed.",
      details: { errors: [{ itemId: "item-1", field: "surface", message: "surface mismatch" }] },
    });

    expect(formatL3ErrorDetails(error)).toBe("{\"currentStatus\":\"confirmed\"}");
    expect(formatL3ErrorDetails(error)).not.toBe("[object Object]");
    expect(formatL3ErrorDetails(validation)).toBeNull();
    expect(validation.itemErrors).toEqual([{ itemId: "item-1", field: "surface", message: "surface mismatch" }]);
  });
});

function proposalItem(overrides: Partial<L3ProposalItemRow>): L3ProposalItemRow {
  return {
    id: "item-1",
    proposal_id: "prop-1",
    user_id: "u1",
    item_type: "context",
    ordinal: 1,
    payload: {},
    status: "pending",
    validation_errors: {},
    active_entity_type: null,
    active_entity_id: null,
    created_at: "now",
    updated_at: "now",
    ...overrides,
  };
}
