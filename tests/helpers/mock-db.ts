/**
 * Mock DB helper — replaces v1's createConfigurableSupabase / setupDbMock.
 *
 * v2's approach is simpler because Repositories use `this.executor.query()`
 * rather than a chain builder. We mock the `pg` Pool so we can assert on
 * SQL text + params without a real DB.
 *
 * Usage:
 *   const mock = createMockPool();
 *   vi.mock("@/db/connection", () => ({ getPool: () => mock.pool }));
 *   const repos = createRepositories();
 *   mock.setRows([{ id: "1", slug: "aboard" }]);
 *   const word = await repos.words.findBySlug("aboard");
 *   expect(mock.lastQuery.text).toContain("WHERE slug = $1");
 */

import { vi } from "vitest";

export interface MockQueryResult {
  rows: unknown[];
  rowCount?: number;
}

export interface MockQueryCall {
  text: string;
  params: unknown[];
}

export function createMockPool() {
  const calls: MockQueryCall[] = [];
  let nextRows: unknown[] = [];
  let rowMap: Map<string, unknown[]> = new Map();

  const pool = {
    query: vi.fn(async (text: string, params?: unknown[]): Promise<MockQueryResult> => {
      calls.push({ text, params: params ?? [] });
      // Check for a pattern-based match first
      for (const [pattern, rows] of rowMap) {
        if (text.includes(pattern)) {
          return { rows: rows as never[], rowCount: rows.length };
        }
      }
      return { rows: nextRows as never[], rowCount: nextRows.length };
    }),
    connect: vi.fn(async () => ({
      query: pool.query,
      release: vi.fn(),
    })),
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    on: vi.fn(),
    end: vi.fn(async () => {}),
  };

  return {
    pool,
    calls,
    /** Set the default rows returned by the next query. */
    setRows(rows: unknown[]) {
      nextRows = rows;
    },
    /** Map a SQL substring → rows, so different queries return different data. */
    setRowMap(map: Record<string, unknown[]>) {
      rowMap = new Map(Object.entries(map));
    },
    /** The most recent query call. */
    get lastQuery(): MockQueryCall | undefined {
      return calls[calls.length - 1];
    },
    /** Reset between tests. */
    reset() {
      calls.length = 0;
      nextRows = [];
      rowMap = new Map();
      pool.query.mockClear();
      pool.connect.mockClear();
    },
  };
}
