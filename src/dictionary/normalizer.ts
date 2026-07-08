/**
 * POS-aware phrase normalization for dictionary collocations.
 *
 * Datamuse returns bare partner words; we must combine the lemma with the
 * partner word in the order that yields a natural English phrase:
 *
 * - adjective lemma + partner noun  → `${lemma} ${word}`  ("abundant rainfall")
 * - noun lemma + partner adjective  → `${word} ${lemma}`  ("heavy rain")
 * - verb/adverb/unknown             → default `${lemma} ${word}`
 *
 * POS strings use the project's dictionary convention (e.g. "adj.", "n.",
 * "v.") and are matched by prefix.
 */

export function buildPhrase(lemma: string, partnerWord: string, pos?: string): string {
  if (pos && pos.startsWith("n")) return `${partnerWord} ${lemma}`;
  return `${lemma} ${partnerWord}`;
}

export function selectRelation(
  pos?: string,
): { rel: string; description: string } | null {
  if (pos && pos.startsWith("adj"))
    return { rel: "rel_jja", description: "noun modified by adjective" };
  if (pos && pos.startsWith("n"))
    return { rel: "rel_jjb", description: "adjective describing noun" };
  // verb/adverb/unknown — no reliable collocation relation in Datamuse.
  return null;
}
