import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Json,
  L3ContextLinkRow,
  L3ContextRow,
  L3GraphReadModel,
  L3ImportJobRow,
  L3OccurrenceRow,
  L3ProposalItemRow,
  L3ProposalRow,
  L3RecommendationItemRow,
  L3RecommendationRunRow,
  L3SourceRow,
  WordRow,
  WordbookRow,
} from "@/domain";
import type {
  IL3ContextRepository,
  IL3ProposalRepository,
  IL3RecommendationRepository,
  IRepositories,
  L3RecommendationLinkGapCandidate,
  L3RecommendationSignal,
  NewL3Context,
  NewL3ContextLink,
  NewL3ImportJob,
  NewL3Occurrence,
  NewL3Proposal,
  NewL3ProposalItem,
  NewL3RecommendationItem,
  NewL3RecommendationRun,
  NewL3Source,
} from "@/repositories/interfaces";
import { L3ImportService } from "@/services/l3-import.service";
import { L3ProposalService } from "@/services/l3-proposal.service";
import { L3ReadService } from "@/services/l3-read.service";
import { L3RecommendationService } from "@/services/l3-recommendation.service";

type WritableTable =
  | "l3_import_jobs"
  | "l3_sources"
  | "l3_contexts"
  | "l3_occurrences"
  | "l3_context_links"
  | "l3_proposals"
  | "l3_proposal_items"
  | "l3_recommendation_runs"
  | "l3_recommendation_items"
  | "user_word_progress"
  | "user_word_l2_progress"
  | "word_l2_content"
  | "words";

interface WriteEvent {
  table: WritableTable;
  operation: "delete" | "insert" | "update";
}

const USER_ID = "00000000-0000-4000-8000-000000000001";
const WORDBOOK_ID = "00000000-0000-4000-8000-000000000010";
const WORD_ID = "00000000-0000-4000-8000-000000000101";
const TARGET_WORD_ID = "00000000-0000-4000-8000-000000000102";
const SOURCE_ID = "00000000-0000-4000-8000-000000000201";
const CONTEXT_ID = "00000000-0000-4000-8000-000000000301";

const writableTables: WritableTable[] = [
  "l3_import_jobs",
  "l3_sources",
  "l3_contexts",
  "l3_occurrences",
  "l3_context_links",
  "l3_proposals",
  "l3_proposal_items",
  "l3_recommendation_runs",
  "l3_recommendation_items",
  "user_word_progress",
  "user_word_l2_progress",
  "word_l2_content",
  "words",
];

const wordbook: WordbookRow = {
  id: WORDBOOK_ID,
  user_id: USER_ID,
  name: "Default",
  description: null,
  is_default: true,
  settings: {},
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const vividWord: WordRow = {
  id: WORD_ID,
  slug: "vivid",
  title: "vivid",
  lemma: "vivid",
  pos: "adj.",
  cefr: null,
  ipa: null,
  aliases: [],
  short_definition: null,
  definition_md: "",
  body_md: "",
  examples: [],
  metadata: {},
  source_path: "words/vivid.md",
  source_updated_at: null,
  content_hash: "a".repeat(64),
  is_published: true,
  is_deleted: false,
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const lucidWord: WordRow = {
  ...vividWord,
  id: TARGET_WORD_ID,
  slug: "lucid",
  title: "lucid",
  lemma: "lucid",
  source_path: "words/lucid.md",
  content_hash: "b".repeat(64),
};

function snapshotWrites(events: WriteEvent[]): Record<WritableTable, number> {
  return Object.fromEntries(
    writableTables.map((table) => [table, events.filter((event) => event.table === table).length]),
  ) as Record<WritableTable, number>;
}

function diffWrites(before: Record<WritableTable, number>, after: Record<WritableTable, number>): Record<WritableTable, number> {
  return Object.fromEntries(
    writableTables.map((table) => [table, after[table] - before[table]]),
  ) as Record<WritableTable, number>;
}

function expectOnlyTablesChanged(
  before: Record<WritableTable, number>,
  after: Record<WritableTable, number>,
  expected: Partial<Record<WritableTable, number>>,
): void {
  const diff = diffWrites(before, after);
  expect(diff).toEqual({
    l3_import_jobs: expected.l3_import_jobs ?? 0,
    l3_sources: expected.l3_sources ?? 0,
    l3_contexts: expected.l3_contexts ?? 0,
    l3_occurrences: expected.l3_occurrences ?? 0,
    l3_context_links: expected.l3_context_links ?? 0,
    l3_proposals: expected.l3_proposals ?? 0,
    l3_proposal_items: expected.l3_proposal_items ?? 0,
    l3_recommendation_runs: expected.l3_recommendation_runs ?? 0,
    l3_recommendation_items: expected.l3_recommendation_items ?? 0,
    user_word_progress: expected.user_word_progress ?? 0,
    user_word_l2_progress: expected.user_word_l2_progress ?? 0,
    word_l2_content: expected.word_l2_content ?? 0,
    words: expected.words ?? 0,
  });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class L3CrossContractHarness {
  readonly writes: WriteEvent[] = [];
  readonly sources = new Map<string, L3SourceRow>();
  readonly contexts = new Map<string, L3ContextRow>();
  readonly occurrences = new Map<string, L3OccurrenceRow>();
  readonly links = new Map<string, L3ContextLinkRow>();
  readonly importJobs = new Map<string, L3ImportJobRow>();
  readonly proposals = new Map<string, L3ProposalRow>();
  readonly proposalItems = new Map<string, L3ProposalItemRow>();
  readonly recommendationRuns = new Map<string, L3RecommendationRunRow>();
  readonly recommendationItems = new Map<string, L3RecommendationItemRow>();

  private ids = {
    importJob: 0,
    source: 0,
    context: 0,
    occurrence: 0,
    link: 0,
    proposal: 0,
    proposalItem: 0,
    run: 0,
    recommendation: 0,
  };

  readonly contextRepo: IL3ContextRepository;
  readonly proposalRepo: IL3ProposalRepository;
  readonly recommendationRepo: IL3RecommendationRepository;
  readonly repositories: IRepositories;
  readonly proposalService: L3ProposalService;
  readonly importService: L3ImportService;
  readonly recommendationService: L3RecommendationService;
  readonly readService: L3ReadService;

  constructor() {
    this.contextRepo = this.makeContextRepo();
    this.proposalRepo = this.makeProposalRepo();
    this.recommendationRepo = this.makeRecommendationRepo();
    this.repositories = {
      l3Context: this.contextRepo,
      l3Proposal: this.proposalRepo,
      l3Recommendation: this.recommendationRepo,
    } as unknown as IRepositories;
    const transaction = {} as PoolClient;
    const txRunner = async <T>(cb: (tx: PoolClient) => Promise<T>): Promise<T> => cb(transaction);
    const repositoryFactory = (tx?: PoolClient): IRepositories => {
      expect(tx).toBe(transaction);
      return this.repositories;
    };
    this.proposalService = new L3ProposalService(
      this.proposalRepo,
      this.contextRepo,
      txRunner,
      repositoryFactory,
    );
    this.importService = new L3ImportService(
      this.contextRepo,
      this.proposalService,
      txRunner,
      repositoryFactory,
    );
    this.recommendationService = new L3RecommendationService(
      this.recommendationRepo,
      this.contextRepo,
      async (cb) => cb({} as never),
      () => this.repositories,
    );
    this.readService = new L3ReadService(
      this.contextRepo,
      txRunner,
      repositoryFactory,
    );
  }

  snapshot(): Record<WritableTable, number> {
    return snapshotWrites(this.writes);
  }

  activeCounts(): { sources: number; contexts: number; occurrences: number; links: number } {
    return {
      sources: this.sources.size,
      contexts: this.contexts.size,
      occurrences: this.occurrences.size,
      links: this.links.size,
    };
  }

  seedActiveSourceContextOccurrences(): void {
    const source: L3SourceRow = {
      id: SOURCE_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      source_type: "manual",
      title: "Seed source",
      author: null,
      url: null,
      language: "en",
      metadata: {},
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    };
    const context: L3ContextRow = {
      id: CONTEXT_ID,
      source_id: SOURCE_ID,
      user_id: USER_ID,
      context_type: "sentence",
      text: "The vivid and lucid explanation stayed memorable.",
      normalized_text: null,
      language: "en",
      position: {},
      metadata: {},
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    };
    this.sources.set(source.id, source);
    this.contexts.set(context.id, context);
    this.occurrences.set("seed-occ-1", {
      id: "seed-occ-1",
      context_id: CONTEXT_ID,
      word_id: WORD_ID,
      user_id: USER_ID,
      surface: "vivid",
      lemma: null,
      start_offset: 4,
      end_offset: 9,
      confidence: "0.9000",
      evidence: {},
      created_at: "2026-07-08T00:00:00Z",
    });
    this.occurrences.set("seed-occ-2", {
      id: "seed-occ-2",
      context_id: CONTEXT_ID,
      word_id: TARGET_WORD_ID,
      user_id: USER_ID,
      surface: "lucid",
      lemma: null,
      start_offset: 14,
      end_offset: 19,
      confidence: "0.9000",
      evidence: {},
      created_at: "2026-07-08T00:00:00Z",
    });
  }

  private record(table: WritableTable, operation: WriteEvent["operation"]): void {
    this.writes.push({ table, operation });
  }

  private nextId(key: keyof L3CrossContractHarness["ids"], prefix: string): string {
    this.ids[key] += 1;
    return `${prefix}-${this.ids[key]}`;
  }

  private findWordById(wordId: string): WordRow | null {
    if (wordId === WORD_ID) return vividWord;
    if (wordId === TARGET_WORD_ID) return lucidWord;
    return null;
  }

  private findWordBySlug(slug: string): WordRow | null {
    if (slug === "vivid") return vividWord;
    if (slug === "lucid") return lucidWord;
    return null;
  }

  private makeContextRepo(): IL3ContextRepository {
    return {
      createSource: vi.fn(async (input: NewL3Source) => {
        this.record("l3_sources", "insert");
        const source: L3SourceRow = {
          id: this.nextId("source", "src"),
          user_id: input.user_id,
          wordbook_id: input.wordbook_id ?? null,
          source_type: input.source_type as never,
          title: input.title,
          author: input.author ?? null,
          url: input.url ?? null,
          language: input.language ?? null,
          metadata: input.metadata ?? {},
          created_at: "2026-07-08T00:00:00Z",
          updated_at: "2026-07-08T00:00:00Z",
        };
        this.sources.set(source.id, source);
        return source;
      }),
      createContext: vi.fn(async (input: NewL3Context) => {
        this.record("l3_contexts", "insert");
        const context: L3ContextRow = {
          id: this.nextId("context", "ctx"),
          source_id: input.source_id,
          user_id: input.user_id,
          context_type: input.context_type as never,
          text: input.text,
          normalized_text: input.normalized_text ?? null,
          language: input.language ?? null,
          position: input.position ?? {},
          metadata: input.metadata ?? {},
          created_at: "2026-07-08T00:00:00Z",
          updated_at: "2026-07-08T00:00:00Z",
        };
        this.contexts.set(context.id, context);
        return context;
      }),
      createOccurrence: vi.fn(async (input: NewL3Occurrence) => {
        this.record("l3_occurrences", "insert");
        const occurrence: L3OccurrenceRow = {
          id: this.nextId("occurrence", "occ"),
          context_id: input.context_id,
          word_id: input.word_id,
          user_id: input.user_id,
          surface: input.surface,
          lemma: input.lemma ?? null,
          start_offset: input.start_offset ?? null,
          end_offset: input.end_offset ?? null,
          confidence: input.confidence ?? null,
          evidence: input.evidence ?? {},
          created_at: "2026-07-08T00:00:00Z",
        };
        this.occurrences.set(occurrence.id, occurrence);
        return occurrence;
      }),
      createContextLink: vi.fn(async (input: NewL3ContextLink) => {
        this.record("l3_context_links", "insert");
        const link: L3ContextLinkRow = {
          id: this.nextId("link", "link"),
          user_id: input.user_id,
          context_id: input.context_id ?? null,
          word_id: input.word_id ?? null,
          link_type: input.link_type as never,
          target_type: input.target_type as never,
          target_id: input.target_id ?? null,
          target_ref: input.target_ref ?? {},
          confidence: input.confidence ?? null,
          provenance: input.provenance ?? {},
          created_at: "2026-07-08T00:00:00Z",
        };
        this.links.set(link.id, link);
        return link;
      }),
      deleteOccurrence: vi.fn(async (userId, occurrenceId) => {
        const occurrence = this.occurrences.get(occurrenceId);
        if (!occurrence || occurrence.user_id !== userId) return null;
        this.record("l3_occurrences", "delete");
        this.occurrences.delete(occurrenceId);
        return occurrence;
      }),
      deleteContextLink: vi.fn(async (userId, contextLinkId) => {
        const link = this.links.get(contextLinkId);
        if (!link || link.user_id !== userId) return null;
        this.record("l3_context_links", "delete");
        this.links.delete(contextLinkId);
        return link;
      }),
      lockSourceByIdForUser: vi.fn(async (userId: string, sourceId: string) => {
        const source = this.sources.get(sourceId);
        return source?.user_id === userId ? source : null;
      }),
      lockContextByIdForUser: vi.fn(async (userId: string, contextId: string) => {
        const context = this.contexts.get(contextId);
        return context?.user_id === userId ? context : null;
      }),
      lockActiveL3TargetReference: vi.fn(async () => undefined),
      getSourceDeleteBlockers: vi.fn(async (userId: string, sourceId: string) => ({
        contextCount: [...this.contexts.values()]
          .filter((context) => context.user_id === userId && context.source_id === sourceId).length,
        inboundContextLinkCount: [...this.links.values()]
          .filter((link) => link.user_id === userId && link.target_type === "source" && link.target_id === sourceId).length,
        importJobCount: [...this.importJobs.values()]
          .filter((job) => job.user_id === userId && job.source_id === sourceId).length,
      })),
      getContextDeleteBlockers: vi.fn(async (userId: string, contextId: string) => ({
        occurrenceCount: [...this.occurrences.values()]
          .filter((occurrence) => occurrence.user_id === userId && occurrence.context_id === contextId).length,
        contextLinkCount: [...this.links.values()]
          .filter((link) => link.user_id === userId && link.context_id === contextId).length,
        inboundContextLinkCount: [...this.links.values()]
          .filter((link) => link.user_id === userId && link.target_type === "context" && link.target_id === contextId).length,
      })),
      deleteSource: vi.fn(async (userId: string, sourceId: string) => {
        const source = this.sources.get(sourceId);
        if (!source || source.user_id !== userId) return null;
        this.record("l3_sources", "delete");
        this.sources.delete(sourceId);
        return source;
      }),
      deleteContext: vi.fn(async (userId: string, contextId: string) => {
        const context = this.contexts.get(contextId);
        if (!context || context.user_id !== userId) return null;
        this.record("l3_contexts", "delete");
        this.contexts.delete(contextId);
        return context;
      }),
      createImportJob: vi.fn(async (input: NewL3ImportJob) => {
        this.record("l3_import_jobs", "insert");
        const importJob: L3ImportJobRow = {
          id: this.nextId("importJob", "job"),
          user_id: input.user_id,
          source_id: input.source_id ?? null,
          status: input.status as never,
          input_hash: input.input_hash,
          input_summary: input.input_summary ?? null,
          stats: input.stats ?? {},
          error: input.error ?? null,
          created_at: "2026-07-08T00:00:00Z",
          updated_at: "2026-07-08T00:00:00Z",
        };
        this.importJobs.set(importJob.id, importJob);
        return importJob;
      }),
      findImportJobByInputHash: vi.fn(async (userId: string, inputHash: string) => {
        for (const job of this.importJobs.values()) {
          if (job.user_id === userId && job.input_hash === inputHash) return job;
        }
        return null;
      }),
      updateImportJobStatus: vi.fn(async (importJobId, userId, status, stats = {}, error = null) => {
        this.record("l3_import_jobs", "update");
        const existing = this.importJobs.get(importJobId);
        const updated: L3ImportJobRow = {
          ...(existing ?? {
            id: importJobId,
            user_id: userId,
            source_id: null,
            input_hash: "missing",
            input_summary: null,
            created_at: "2026-07-08T00:00:00Z",
          }),
          user_id: userId,
          status: status as never,
          stats,
          error,
          updated_at: "2026-07-08T00:00:01Z",
        };
        this.importJobs.set(importJobId, updated);
        return updated;
      }),
      findWordbookByIdForUser: vi.fn(async (userId, wordbookId) => userId === USER_ID && wordbookId === WORDBOOK_ID ? wordbook : null),
      findSourceById: vi.fn(async (userId, sourceId) => {
        const source = this.sources.get(sourceId);
        return source?.user_id === userId ? source : null;
      }),
      findContextById: vi.fn(async (userId, contextId) => {
        const context = this.contexts.get(contextId);
        return context?.user_id === userId ? context : null;
      }),
      findContextWithSourceById: vi.fn(async (userId, contextId) => {
        const context = this.contexts.get(contextId);
        const source = context ? this.sources.get(context.source_id) : null;
        return context?.user_id === userId && source?.user_id === userId ? { context, source } : null;
      }),
      findWordById: vi.fn(async (wordId) => this.findWordById(wordId)),
      findWordBySlug: vi.fn(async (slug) => this.findWordBySlug(slug)),
      findWordInWordbookById: vi.fn(async (wordbookId, wordId) => wordbookId === WORDBOOK_ID ? this.findWordById(wordId) : null),
      findWordInWordbookBySlug: vi.fn(async (wordbookId, slug) => wordbookId === WORDBOOK_ID ? this.findWordBySlug(slug) : null),
      listContextsForWord: vi.fn(),
      listContextsForSource: vi.fn(),
      getContextDetail: vi.fn(async (userId, contextId) => {
        const context = this.contexts.get(contextId);
        const source = context ? this.sources.get(context.source_id) : null;
        if (!context || !source || context.user_id !== userId) return null;
        return {
          context,
          source,
          occurrences: [...this.occurrences.values()].filter((occurrence) => occurrence.context_id === contextId),
          links: [...this.links.values()].filter((link) => link.context_id === contextId),
        };
      }),
      getWordSpace: vi.fn(async () => null),
      getSourceSpace: vi.fn(async () => null),
      getGraph: vi.fn(async (input): Promise<L3GraphReadModel> => ({
        nodes: [],
        edges: [],
        stats: {
          sourceCount: this.sources.size,
          contextCount: this.contexts.size,
          occurrenceCount: this.occurrences.size,
          linkCount: this.links.size,
          nodeCount: 0,
          edgeCount: 0,
        },
        limit: input.limit,
        cursor: input.cursor ?? null,
        nextCursor: null,
        metadata: {
          sources: [...this.sources.values()],
          contexts: [...this.contexts.values()],
          occurrences: [...this.occurrences.values()],
          links: [...this.links.values()],
        } as unknown as Json,
      })),
    } as IL3ContextRepository;
  }

  private makeProposalRepo(): IL3ProposalRepository {
    return {
      createProposal: vi.fn(async (input: NewL3Proposal) => {
        this.record("l3_proposals", "insert");
        const proposal: L3ProposalRow = {
          id: this.nextId("proposal", "prop"),
          user_id: input.user_id,
          wordbook_id: input.wordbook_id ?? null,
          source_type: input.source_type as never,
          status: "pending",
          title: input.title ?? null,
          summary: input.summary ?? null,
          input_hash: input.input_hash ?? null,
          proposed_by: input.proposed_by ?? null,
          provenance: input.provenance ?? {},
          review_note: null,
          confirmed_at: null,
          rejected_at: null,
          created_at: "2026-07-08T00:00:00Z",
          updated_at: "2026-07-08T00:00:00Z",
        };
        this.proposals.set(proposal.id, proposal);
        return proposal;
      }),
      createProposalItem: vi.fn(async (input: NewL3ProposalItem) => {
        this.record("l3_proposal_items", "insert");
        const item: L3ProposalItemRow = {
          id: this.nextId("proposalItem", "item"),
          proposal_id: input.proposal_id,
          user_id: input.user_id,
          item_type: input.item_type as never,
          ordinal: input.ordinal,
          payload: input.payload,
          status: "pending",
          validation_errors: input.validation_errors ?? [],
          active_entity_type: null,
          active_entity_id: null,
          created_at: "2026-07-08T00:00:00Z",
          updated_at: "2026-07-08T00:00:00Z",
        };
        this.proposalItems.set(item.id, item);
        return item;
      }),
      findProposalByIdForUser: vi.fn(async (userId, proposalId) => {
        const proposal = this.proposals.get(proposalId);
        return proposal && proposal.user_id === userId ? proposal : null;
      }),
      findProposalByInputHash: vi.fn(async (userId: string, inputHash: string) => {
        for (const p of this.proposals.values()) {
          if (p.user_id === userId && p.input_hash === inputHash) return p;
        }
        return null;
      }),
      lockProposalByIdForUser: vi.fn(async (userId, proposalId) => {
        const proposal = this.proposals.get(proposalId);
        return proposal && proposal.user_id === userId ? proposal : null;
      }),
      findProposalItems: vi.fn(async (userId, proposalId) => [...this.proposalItems.values()]
        .filter((item) => item.user_id === userId && item.proposal_id === proposalId)
        .sort((a, b) => a.ordinal - b.ordinal)),
      getProposalBundle: vi.fn(async (userId, proposalId) => {
        const proposal = this.proposals.get(proposalId);
        if (!proposal || proposal.user_id !== userId) return null;
        return {
          proposal,
          items: [...this.proposalItems.values()]
            .filter((item) => item.user_id === userId && item.proposal_id === proposalId)
            .sort((a, b) => a.ordinal - b.ordinal),
        };
      }),
      listProposals: vi.fn(async () => ({ items: [...this.proposals.values()], limit: 20, cursor: null, nextCursor: null })),
      updateProposalItemValidation: vi.fn(async (itemId, userId, validationErrors) => {
        this.record("l3_proposal_items", "update");
        const item = this.proposalItems.get(itemId);
        if (!item || item.user_id !== userId) throw new Error("proposal item not found");
        const updated = { ...item, validation_errors: validationErrors, updated_at: "2026-07-08T00:00:01Z" };
        this.proposalItems.set(itemId, updated);
        return updated;
      }),
      markProposalItemConfirmed: vi.fn(async (itemId, userId, activeEntityType, activeEntityId) => {
        this.record("l3_proposal_items", "update");
        const item = this.proposalItems.get(itemId);
        if (!item || item.user_id !== userId) throw new Error("proposal item not found");
        const updated: L3ProposalItemRow = {
          ...item,
          status: "confirmed",
          active_entity_type: activeEntityType as never,
          active_entity_id: activeEntityId,
          updated_at: "2026-07-08T00:00:01Z",
        };
        this.proposalItems.set(itemId, updated);
        return updated;
      }),
      markProposalItemsRejected: vi.fn(async () => undefined),
      markProposalConfirmed: vi.fn(async (proposalId, userId) => {
        this.record("l3_proposals", "update");
        const proposal = this.proposals.get(proposalId);
        if (!proposal || proposal.user_id !== userId) throw new Error("proposal not found");
        const updated: L3ProposalRow = {
          ...proposal,
          status: "confirmed",
          confirmed_at: "2026-07-08T00:00:01Z",
          updated_at: "2026-07-08T00:00:01Z",
        };
        this.proposals.set(proposalId, updated);
        return updated;
      }),
      markProposalRejected: vi.fn(async (proposalId, userId, reviewNote = null) => {
        this.record("l3_proposals", "update");
        const proposal = this.proposals.get(proposalId);
        if (!proposal || proposal.user_id !== userId) throw new Error("proposal not found");
        const updated: L3ProposalRow = {
          ...proposal,
          status: "rejected",
          review_note: reviewNote,
          rejected_at: "2026-07-08T00:00:01Z",
          updated_at: "2026-07-08T00:00:01Z",
        };
        this.proposals.set(proposalId, updated);
        return updated;
      }),
    };
  }

  private makeRecommendationRepo(): IL3RecommendationRepository {
    return {
      createRun: vi.fn(async (input: NewL3RecommendationRun) => {
        this.record("l3_recommendation_runs", "insert");
        const run: L3RecommendationRunRow = {
          id: this.nextId("run", "run"),
          user_id: input.user_id,
          wordbook_id: input.wordbook_id ?? null,
          mode: input.mode as never,
          status: "completed",
          input_hash: input.input_hash ?? null,
          stats: input.stats ?? {},
          created_at: "2026-07-08T00:00:00Z",
          completed_at: "2026-07-08T00:00:00Z",
        };
        this.recommendationRuns.set(run.id, run);
        return run;
      }),
      createItem: vi.fn(async (input: NewL3RecommendationItem) => {
        this.record("l3_recommendation_items", "insert");
        const item: L3RecommendationItemRow = {
          id: this.nextId("recommendation", "rec"),
          run_id: input.run_id,
          user_id: input.user_id,
          wordbook_id: input.wordbook_id ?? null,
          recommendation_type: input.recommendation_type as never,
          status: "pending",
          title: input.title,
          summary: input.summary,
          priority_score: input.priority_score.toFixed(4),
          confidence: input.confidence.toFixed(4),
          reason_codes: input.reason_codes,
          evidence: input.evidence,
          payload: input.payload,
          accepted_proposal_id: null,
          created_at: "2026-07-08T00:00:00Z",
          updated_at: "2026-07-08T00:00:00Z",
          expires_at: input.expires_at ?? null,
          accepted_at: null,
          rejected_at: null,
          dismissed_at: null,
        };
        this.recommendationItems.set(item.id, item);
        return item;
      }),
      listItems: vi.fn(async () => ({ items: [...this.recommendationItems.values()], limit: 20, cursor: null, nextCursor: null })),
      findItemByIdForUser: vi.fn(async (userId, itemId) => {
        const item = this.recommendationItems.get(itemId);
        return item && item.user_id === userId ? item : null;
      }),
      lockItemByIdForUser: vi.fn(async (userId, itemId) => {
        const item = this.recommendationItems.get(itemId);
        return item && item.user_id === userId ? item : null;
      }),
      markItemStatus: vi.fn(async (itemId, userId, status, acceptedProposalId = null) => {
        this.record("l3_recommendation_items", "update");
        const item = this.recommendationItems.get(itemId);
        if (!item || item.user_id !== userId) throw new Error("recommendation item not found");
        const updated: L3RecommendationItemRow = {
          ...item,
          status: status as never,
          accepted_proposal_id: acceptedProposalId ?? item.accepted_proposal_id,
          accepted_at: status === "accepted" ? "2026-07-08T00:00:01Z" : item.accepted_at,
          rejected_at: status === "rejected" ? "2026-07-08T00:00:01Z" : item.rejected_at,
          dismissed_at: status === "dismissed" ? "2026-07-08T00:00:01Z" : item.dismissed_at,
          updated_at: "2026-07-08T00:00:01Z",
        };
        this.recommendationItems.set(itemId, updated);
        return updated;
      }),
      findSignals: vi.fn(async (): Promise<L3RecommendationSignal[]> => [{
        word_id: WORD_ID,
        slug: "vivid",
        title: "vivid",
        due_at: "2026-07-08T00:00:00Z",
        state: "review",
        retrievability: "0.4000",
        l1_weak_signal: true,
        review_count: 2,
        l2_retrievability: null,
        l2_due_at: null,
        l2_review_count: null,
        l2_paused: null,
        l2_fields: ["corpus"],
        l3_context_count: this.occurrences.size > 0 ? 1 : 0,
        l3_occurrence_count: this.occurrences.size,
        l3_link_count: this.links.size,
        graph_neighbor_count: this.links.size,
      }]),
      findLinkGapCandidates: vi.fn(async (): Promise<L3RecommendationLinkGapCandidate[]> => {
        const hasActiveLink = [...this.links.values()].some((link) =>
          link.target_type === "word" &&
          ((link.word_id === WORD_ID && link.target_id === TARGET_WORD_ID) ||
            (link.word_id === TARGET_WORD_ID && link.target_id === WORD_ID)),
        );
        return hasActiveLink
          ? []
          : [{
              context_id: CONTEXT_ID,
              source_id: SOURCE_ID,
              word_id: WORD_ID,
              word_slug: "vivid",
              target_word_id: TARGET_WORD_ID,
              target_word_slug: "lucid",
              cooccurrence_count: 2,
            }];
      }),
    };
  }
}

let harness: L3CrossContractHarness;

beforeEach(() => {
  harness = new L3CrossContractHarness();
});

describe("L3 cross-contract regression suite", () => {
  it("keeps raw import proposal-only until confirmProposal upgrades to active L3", async () => {
    const beforeImport = harness.snapshot();
    const imported = await harness.importService.createRawTextImportProposal({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      source: { sourceType: "manual", title: "Imported note", language: "en" },
      text: "A vivid example.",
      targetWords: [{ slug: "vivid" }],
    });
    const afterImport = harness.snapshot();

    expectOnlyTablesChanged(beforeImport, afterImport, {
      l3_import_jobs: 1,
      l3_proposals: 1,
      l3_proposal_items: 3,
    });
    expect(imported.importJob.status).toBe("completed");
    expect(harness.activeCounts()).toEqual({ sources: 0, contexts: 0, occurrences: 0, links: 0 });

    const beforeConfirm = harness.snapshot();
    const confirmed = await harness.proposalService.confirmProposal({
      userId: USER_ID,
      proposalId: imported.proposal.id,
    });
    const afterConfirm = harness.snapshot();

    expectOnlyTablesChanged(beforeConfirm, afterConfirm, {
      l3_sources: 1,
      l3_contexts: 1,
      l3_occurrences: 1,
      l3_proposal_items: 6,
      l3_proposals: 1,
    });
    expect(confirmed.proposal.status).toBe("confirmed");
    expect(confirmed.activeEntities.map((entity) => entity.activeEntityType)).toEqual(["source", "context", "occurrence"]);
    expect([...harness.sources.values()].every((source) => source.user_id === USER_ID)).toBe(true);
    expect([...harness.contexts.values()].every((context) => context.user_id === USER_ID)).toBe(true);
    expect([...harness.occurrences.values()].every((occurrence) => occurrence.user_id === USER_ID)).toBe(true);
  });

  it("keeps structured import proposal-only until confirmProposal upgrades every item type", async () => {
    const beforeImport = harness.snapshot();
    const imported = await harness.importService.createStructuredImportProposal({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      source: { sourceType: "manual", title: "Structured import", language: "en" },
      contexts: [{
        clientRef: "ctx-structured",
        contextType: "sentence",
        text: "The vivid example links outward.",
        occurrences: [{ slug: "vivid", surface: "vivid", startOffset: 4, endOffset: 9 }],
        links: [{
          wordId: WORD_ID,
          linkType: "illustrates",
          targetType: "external",
          targetRef: { url: "https://example.com/structured" },
          confidence: 0.8,
        }],
      }],
    });
    const afterImport = harness.snapshot();

    expectOnlyTablesChanged(beforeImport, afterImport, {
      l3_import_jobs: 1,
      l3_proposals: 1,
      l3_proposal_items: 4,
    });
    expect(imported.importJob.status).toBe("completed");
    expect(imported.items.map((item) => item.item_type)).toEqual(["source", "context", "occurrence", "context_link"]);
    expect(harness.activeCounts()).toEqual({ sources: 0, contexts: 0, occurrences: 0, links: 0 });

    const beforeConfirm = harness.snapshot();
    const confirmed = await harness.proposalService.confirmProposal({
      userId: USER_ID,
      proposalId: imported.proposal.id,
    });
    const afterConfirm = harness.snapshot();

    expectOnlyTablesChanged(beforeConfirm, afterConfirm, {
      l3_sources: 1,
      l3_contexts: 1,
      l3_occurrences: 1,
      l3_context_links: 1,
      l3_proposal_items: 8,
      l3_proposals: 1,
    });
    expect(confirmed.proposal.status).toBe("confirmed");
    expect(confirmed.activeEntities.map((entity) => entity.activeEntityType)).toEqual([
      "source",
      "context",
      "occurrence",
      "context_link",
    ]);
    expect([...harness.links.values()][0]).toMatchObject({
      user_id: USER_ID,
      word_id: WORD_ID,
      target_type: "external",
    });
  });

  it("bridges link_gap recommendation through proposal before active context_link creation", async () => {
    harness.seedActiveSourceContextOccurrences();

    const beforeGenerate = harness.snapshot();
    const generated = await harness.recommendationService.generateRecommendations({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      mode: "link_suggestions",
      limit: 5,
    });
    const afterGenerate = harness.snapshot();

    expect(generated.items).toHaveLength(1);
    expect(generated.items[0]).toMatchObject({ recommendation_type: "link_gap", status: "pending" });
    expectOnlyTablesChanged(beforeGenerate, afterGenerate, {
      l3_recommendation_runs: 1,
      l3_recommendation_items: 1,
    });
    expect(harness.links).toHaveLength(0);

    const beforeAccept = harness.snapshot();
    const accepted = await harness.recommendationService.acceptRecommendation({
      userId: USER_ID,
      recommendationId: generated.items[0].id,
    });
    const afterAccept = harness.snapshot();

    expectOnlyTablesChanged(beforeAccept, afterAccept, {
      l3_proposals: 1,
      l3_proposal_items: 1,
      l3_recommendation_items: 1,
    });
    expect(accepted.item.status).toBe("accepted");
    expect(accepted.item.accepted_proposal_id).toBeTruthy();
    expect(harness.links).toHaveLength(0);

    const beforeConfirm = harness.snapshot();
    const confirmed = await harness.proposalService.confirmProposal({
      userId: USER_ID,
      proposalId: accepted.item.accepted_proposal_id ?? "",
    });
    const afterConfirm = harness.snapshot();

    expectOnlyTablesChanged(beforeConfirm, afterConfirm, {
      l3_context_links: 1,
      l3_proposal_items: 2,
      l3_proposals: 1,
    });
    expect(confirmed.activeEntities).toEqual([expect.objectContaining({ activeEntityType: "context_link" })]);
    expect([...harness.links.values()][0]).toMatchObject({
      user_id: USER_ID,
      context_id: CONTEXT_ID,
      word_id: WORD_ID,
      target_type: "word",
      target_id: TARGET_WORD_ID,
    });

    const beforeRegenerate = harness.snapshot();
    const regenerated = await harness.recommendationService.generateRecommendations({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      mode: "link_suggestions",
      limit: 5,
    });
    const afterRegenerate = harness.snapshot();

    expect(regenerated.items).toHaveLength(0);
    expectOnlyTablesChanged(beforeRegenerate, afterRegenerate, { l3_recommendation_runs: 1 });
  });

  it("keeps graph reads deterministic and write-free across active/proposal/recommendation state", async () => {
    harness.seedActiveSourceContextOccurrences();
    await harness.recommendationService.generateRecommendations({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      mode: "review_pack",
      limit: 5,
    });
    const proposal = await harness.proposalService.createProposal({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      sourceType: "agent",
      items: [{ itemType: "source", payload: { sourceType: "manual", title: "Pending note" } }],
    });
    expect(proposal.proposal.status).toBe("pending");

    const beforeRead = harness.snapshot();
    const first = await harness.readService.getGraph({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      slug: "vivid",
      depth: 1,
      limit: 100,
    });
    const second = await harness.readService.getGraph({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      slug: "vivid",
      depth: 1,
      limit: 100,
    });
    const afterRead = harness.snapshot();

    expectOnlyTablesChanged(beforeRead, afterRead, {});
    expect(cloneJson(second)).toEqual(cloneJson(first));
    expect(first.nodes.length).toBeGreaterThan(0);
    expect(first.edges.length).toBeGreaterThan(0);
    expect([...harness.proposals.values()].some((item) => item.status === "pending")).toBe(true);
    expect([...harness.recommendationItems.values()].every((item) => item.status === "pending")).toBe(true);
  });

  it("keeps recommendation generation isolated from active L3, proposals, L1/L2, and words writes", async () => {
    harness.seedActiveSourceContextOccurrences();
    const before = harness.snapshot();
    const result = await harness.recommendationService.generateRecommendations({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      mode: "gap_scan",
      limit: 10,
    });
    const after = harness.snapshot();

    expect(result.items.map((item) => item.recommendation_type)).toEqual(
      expect.arrayContaining(["link_gap", "l2_gap", "weak_word"]),
    );
    expectOnlyTablesChanged(before, after, {
      l3_recommendation_runs: 1,
      l3_recommendation_items: result.items.length,
    });
  });

  it("keeps dry-run recommendations fully write-free with deterministic payloads", async () => {
    harness.seedActiveSourceContextOccurrences();
    const before = harness.snapshot();
    const first = await harness.recommendationService.generateRecommendations({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      mode: "gap_scan",
      dryRun: true,
      limit: 10,
    });
    const second = await harness.recommendationService.generateRecommendations({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      mode: "gap_scan",
      dryRun: true,
      limit: 10,
    });
    const after = harness.snapshot();

    expectOnlyTablesChanged(before, after, {});
    expect(first.run.id).toBe("dry-run");
    expect(second.run.id).toBe("dry-run");
    expect(cloneJson(second)).toEqual(cloneJson(first));
  });
});
