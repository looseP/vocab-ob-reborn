export type OffsetPage<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export type CursorPage<T> = {
  items: T[];
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
};

export type OffsetPageAdapter<T> = OffsetPage<T> & {
  kind: "offset";
  hasNextPage: boolean;
  nextOffset: number | null;
};

export type CursorPageAdapter<T> = CursorPage<T> & {
  kind: "cursor";
  hasNextPage: boolean;
};

export function adaptOffsetPage<T>(page: OffsetPage<T>): OffsetPageAdapter<T> {
  const nextOffset = page.offset + page.items.length;
  const hasNextPage = nextOffset < page.total;
  return { ...page, kind: "offset", hasNextPage, nextOffset: hasNextPage ? nextOffset : null };
}

export function adaptCursorPage<T>(page: CursorPage<T>): CursorPageAdapter<T> {
  return { ...page, kind: "cursor", hasNextPage: page.nextCursor !== null };
}
