/**
 * Shared value types for the L1 vocabulary-note ingestion pipeline.
 * Kept dependency-free by design: src/ingest is a pure-function layer that
 * neither imports nor is imported by repositories/services/db.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export interface ParsedIdentity {
  lemma: string;
  title: string;
  pos: string | null;
  ipa: string | null;
  cefr: string | null;
  aliases: string[];
}

export interface ParsedCoreDefinition {
  /** Chinese sense line, e.g. "在交通工具上". */
  sense: string;
  en: string | null;
  priority: number | null;
  tags: string[];
}

export interface ParsedMorphology {
  prefix: string | null;
  root: string | null;
  suffix: string | null;
  family: string[];
}

export interface ParsedMnemonic {
  type: string | null;
  text: string;
}

/** One `## <headword>` entry inside a collection note, mapped to words columns. */
export interface IngestWord {
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  ipa: string | null;
  cefr: string | null;
  aliases: string[];
  shortDefinition: string | null;
  coreDefinitions: ParsedCoreDefinition[];
  /** Markdown rendered from coreDefinitions — feeds words.definition_md. */
  definitionMd: string;
  prototypeText: string | null;
  morphology: ParsedMorphology;
  etymologyNarrative: string | null;
  mnemonic: ParsedMnemonic | null;
  semanticChain: string | null;
  reviewerNotes: string[];
  confidence: "source-backed" | "uncertain" | null;
  /** Raw markdown of the whole entry (lossless round-trip payload). */
  bodyMd: string;
  /** Structured extras destined for words.metadata JSONB. */
  metadata: Record<string, Json>;
  warnings: string[];
}

export interface IngestCollectionHeader {
  title: string;
  notes: string[];
}

export interface IngestCollectionFile {
  header: IngestCollectionHeader;
  words: IngestWord[];
}
