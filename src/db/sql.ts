/**
 * Tagged-template SQL helper — runs a raw parameterized query through the pool.
 *
 * Usage:
 *   const { data, error } = await sql<WordRow>`
 *     SELECT id, slug FROM words WHERE slug = ${slug}
 *   `;
 *
 * Ported from v1's lib/db/sql.ts unchanged in behaviour.
 */

import { getPool } from "./connection";
import type { DbArrayResult, PgError } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic default
export async function sql<T = any>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<DbArrayResult<T>> {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) {
    text += `$${i + 1}` + strings[i + 1];
  }
  try {
    const { rows } = await getPool().query(text, values);
    return { data: rows, error: null };
  } catch (err) {
    return {
      data: null,
      error: {
        message: (err as Error).message,
        code: (err as PgError).code,
      },
    };
  }
}
