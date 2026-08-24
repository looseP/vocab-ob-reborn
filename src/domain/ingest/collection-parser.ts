/**
 * Collection-note parser for the L1/L0 vocabulary migration format.
 *
 * Expected shape (verified against the 2026-08-22 migration corpus,
 * 6767 entries / 264 files):
 *
 *   # <collection title>
 *   > header note lines (batch info, conventions, audit status)
 *   ---
 *   ## <headword>
 *   ### Identity        - lemma/title/pos/ipa/cefr/aliases list items
 *   ### Short Definition
 *   ### Core Definitions  numbered senses with - en/- priority/- tags subs
 *   ### Prototype
 *   ### Morphology      - prefix/root/suffix/family (fields may be blank)
 *   ### Etymology Narrative
 *   ### Mnemonic        - type/text
 *   ### Semantic Chain
 *   ### Reviewer Notes  bullets + `- confidence: source-backed|uncertain`
 *
 * Pure functions only — no I/O, no framework imports.
 */

import type {
  IngestCollectionFile,
  IngestCollectionHeader,
  IngestWord,
  Json,
  ParsedCoreDefinition,
} from "./types";
import { isBlank, slugifyHeadword } from "./utils";

const WORD_HEADING_RE = /^## (.+)$/gm;
const SECTION_HEADING_RE = /^### (.+)$/gm;

export function parseCollectionHeader(markdown: string): IngestCollectionHeader {
  const beforeFirstWord = markdown.split(/^## /m)[0] ?? "";
  const title = /^#\s+(.+)$/m.exec(beforeFirstWord)?.[1]?.trim() ?? "";
  const notes = beforeFirstWord
    .split(/\r?\n/)
    .filter((line) => line.startsWith(">"))
    .map((line) => line.replace(/^>\s?/, "").trim())
    .filter(Boolean);
  return { title, notes };
}

function splitSections(body: string): Map<string, string> {
  const map = new Map<string, string>();
  const matches = [...body.matchAll(SECTION_HEADING_RE)];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i]![1].trim();
    const start = (matches[i]!.index ?? 0) + matches[i]![0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? body.length) : body.length;
    const current = map.get(name);
    const chunk = body.slice(start, end).trim();
    map.set(name, current ? `${current}\n${chunk}` : chunk);
  }
  return map;
}

function parseListItems(sectionBody: string): Array<[string, string]> {
  const items: Array<[string, string]> = [];
  for (const line of sectionBody.split(/\r?\n/)) {
    const match = /^-\s*([^:：]+?)\s*:\s*(.*)$/.exec(line.trim());
    if (match) items.push([match[1]!.trim(), match[2]!.trim()]);
  }
  return items;
}

function normalizeAlias(raw: string): string {
  // "aircraft (单复同形)" / "airplanes" → base alias token without notes.
  return raw.replace(/\s*[（(][^）)]*[）)]\s*/g, "").trim();
}

function parseAliases(value: string): string[] {
  if (isBlank(value)) return [];
  return value
    .split(/[,，;；]/)
    .map((item) => normalizeAlias(item))
    .filter((item) => item.length > 0 && !/^[—–\-]+$/.test(item));
}

function parseIdentity(sectionBody: string | undefined, warnings: string[]): {
  lemma: string;
  title: string;
  pos: string | null;
  ipa: string | null;
  cefr: string | null;
  aliases: string[];
} {
  const items = parseListItems(sectionBody ?? "");
  const get = (key: string): string | null => {
    const found = items.find(([k]) => k.toLowerCase() === key);
    return found && !isBlank(found[1]) ? found[1] : null;
  };
  if (!sectionBody || items.length === 0) warnings.push("Identity 小节缺失或为空");
  const lemma = get("lemma") ?? get("title");
  if (!lemma) warnings.push("Identity 缺少 lemma");
  const title = get("title") ?? lemma ?? "";
  const aliasValue = get("aliases");
  return {
    lemma: lemma ?? "",
    title,
    pos: get("pos"),
    ipa: get("ipa"),
    cefr: get("cefr"),
    aliases:
      aliasValue === null || /^[-–—]+$/.test(aliasValue.trim())
        ? []
        : parseAliases(aliasValue),
  };
}

const CORE_SUB_KEYS = new Set(["en", "priority", "tags"]);

function parseCoreDefinitions(sectionBody: string | undefined): ParsedCoreDefinition[] {
  if (!sectionBody?.trim()) return [];
  const definitions: ParsedCoreDefinition[] = [];
  let current: ParsedCoreDefinition | null = null;
  const pushCurrent = () => {
    if (current) definitions.push(current);
    current = null;
  };
  for (const rawLine of sectionBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const numbered = /^\d+[.、]\s*(.+)$/.exec(line);
    if (numbered) {
      pushCurrent();
      current = { sense: numbered[1]!.trim(), en: null, priority: null, tags: [] };
      continue;
    }

    const bullet = /^-\s*(.+)$/.exec(line);
    if (bullet) {
      const keyed = /^([^:：]+?)\s*:\s*(.*)$/.exec(bullet[1]!);
      if (keyed && CORE_SUB_KEYS.has(keyed[1]!.trim().toLowerCase()) && current) {
        const key = keyed[1]!.trim().toLowerCase();
        const value = keyed[2]!.trim();
        if (key === "en") current.en = isBlank(value) ? null : value;
        else if (key === "priority") {
          const parsed = Number.parseInt(value, 10);
          current.priority = Number.isFinite(parsed) ? parsed : null;
        } else if (key === "tags") {
          current.tags = value
            .split(/[,，;；]/)
            .map((tag) => tag.trim())
            .filter(Boolean);
        }
        continue;
      }
      // Plain bullet without sub-keys = a sense of its own (沙场争锋 variant).
      pushCurrent();
      current = { sense: bullet[1]!.trim(), en: null, priority: null, tags: [] };
      continue;
    }

    // Bare paragraph line inside the section — treat as its own sense.
    pushCurrent();
    current = { sense: line, en: null, priority: null, tags: [] };
  }
  pushCurrent();
  return sortByPriority(definitions.filter((def) => def.sense.length > 0));
}

/**
 * Display order must follow recognition priority regardless of the order the
 * senses were written in. Stable for ties and for missing priorities (kept at
 * the end, in file order).
 */
function sortByPriority(definitions: ParsedCoreDefinition[]): ParsedCoreDefinition[] {
  return definitions
    .map((def, index) => ({ def, index }))
    .sort((a, b) => {
      const pa = a.def.priority ?? Number.MAX_SAFE_INTEGER;
      const pb = b.def.priority ?? Number.MAX_SAFE_INTEGER;
      return pa === pb ? a.index - b.index : pa - pb;
    })
    .map((entry) => entry.def);
}

function renderDefinitionMd(definitions: ParsedCoreDefinition[]): string {
  return definitions
    .map((def, index) => {
      const lines = [`${index + 1}. ${def.sense}`];
      if (def.en) lines.push(`   - en: ${def.en}`);
      if (def.priority != null) lines.push(`   - priority: ${def.priority}`);
      if (def.tags.length > 0) lines.push(`   - tags: ${def.tags.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n");
}

function parseMorphology(sectionBody: string | undefined) {
  const items = new Map(parseListItems(sectionBody ?? ""));
  const field = (key: string): string | null => {
    const value = items.get(key);
    return isBlank(value) ? null : value!;
  };
  return {
    prefix: field("prefix"),
    root: field("root"),
    suffix: field("suffix"),
    family: (items.get("family") ?? "")
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function parseMnemonic(sectionBody: string | undefined) {
  if (!sectionBody?.trim()) return null;
  let type: string | null = null;
  const textParts: string[] = [];
  for (const rawLine of sectionBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const dashType = /^-\s*type\s*:\s*(.+)$/i.exec(line);
    const boldType = /^\*\*type\*\*\s*:\s*(.+)$/i.exec(line);
    const dashText = /^-\s*text\s*:\s*(.+)$/i.exec(line);
    if (dashType) type = dashType[1]!.trim();
    else if (boldType) type = boldType[1]!.trim();
    else if (dashText) textParts.push(dashText[1]!.trim());
    else textParts.push(line.replace(/^-\s*/, ""));
  }
  const text = textParts.join(" ").trim();
  if (!text) return null;
  return { type: isBlank(type) ? null : type, text };
}

function buildMetadata(word: {
  morphology: ReturnType<typeof parseMorphology>;
  etymologyNarrative: string | null;
  mnemonic: ReturnType<typeof parseMnemonic>;
  semanticChain: string | null;
  reviewerNotes: string[];
  confidence: IngestWord["confidence"];
}): Record<string, Json> {
  const metadata: Record<string, Json> = {};
  if (word.morphology.prefix) metadata.morphology_prefix = word.morphology.prefix;
  if (word.morphology.root) metadata.morphology_root = word.morphology.root;
  if (word.morphology.suffix) metadata.morphology_suffix = word.morphology.suffix;
  if (word.morphology.family.length > 0) metadata.morphology_family = word.morphology.family;
  if (word.etymologyNarrative) metadata.etymology_narrative = word.etymologyNarrative;
  if (word.mnemonic) {
    metadata.mnemonic_type = word.mnemonic.type;
    metadata.mnemonic_text = word.mnemonic.text;
  }
  if (word.semanticChain) metadata.semantic_chain = word.semanticChain;
  if (word.reviewerNotes.length > 0) metadata.reviewer_notes = word.reviewerNotes;
  if (word.confidence) metadata.confidence = word.confidence;
  return metadata;
}

function parseWordBlock(block: string): IngestWord {
  const warnings: string[] = [];
  const title = /^##\s+(.+)$/m.exec(block)?.[1]?.trim() ?? "";
  const sections = splitSections(block);

  const identity = parseIdentity(sections.get("Identity"), warnings);
  const shortDef = sections.get("Short Definition");
  const coreDefinitions = parseCoreDefinitions(sections.get("Core Definitions"));
  if (coreDefinitions.length === 0) warnings.push("Core Definitions 缺失或无法解析");
  const prototype = sections.get("Prototype")?.trim() ?? "";
  const morphology = parseMorphology(sections.get("Morphology"));
  const etymology = sections.get("Etymology Narrative")?.trim() ?? "";
  const mnemonic = parseMnemonic(sections.get("Mnemonic"));
  const semanticChain = sections.get("Semantic Chain")?.trim() ?? "";
  const reviewerNotes = (sections.get("Reviewer Notes") ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean);

  const confidenceMatch = /^- confidence:\s*(.+)$/m.exec(sections.get("Reviewer Notes") ?? "");
  const rawConfidence = confidenceMatch?.[1]?.trim();
  const confidence =
    rawConfidence === "source-backed" || rawConfidence === "uncertain" ? rawConfidence : null;

  const lemma = identity.lemma || title;
  const slug = slugifyHeadword(lemma);
  if (!slug) warnings.push(`slug 为空（lemma="${lemma}"）`);

  for (const name of sections.keys()) {
    if (
      ![
        "Identity",
        "Short Definition",
        "Core Definitions",
        "Prototype",
        "Morphology",
        "Etymology Narrative",
        "Mnemonic",
        "Semantic Chain",
        "Reviewer Notes",
      ].includes(name)
    ) {
      warnings.push(`未知小节 "${name}"（内容保留在 bodyMd）`);
    }
  }

  const word: IngestWord = {
    slug,
    title: identity.title || title,
    lemma,
    pos: identity.pos,
    ipa: identity.ipa,
    cefr: identity.cefr,
    aliases: identity.aliases,
    shortDefinition: isBlank(shortDef) ? null : shortDef!.trim(),
    coreDefinitions,
    definitionMd: renderDefinitionMd(coreDefinitions),
    prototypeText: isBlank(prototype) ? null : prototype,
    morphology,
    etymologyNarrative: isBlank(etymology) ? null : etymology,
    mnemonic,
    semanticChain: isBlank(semanticChain) ? null : semanticChain,
    reviewerNotes,
    confidence,
    bodyMd: block.trim(),
    metadata: buildMetadata({
      morphology,
      etymologyNarrative: word_metadata_etymology(etymology),
      mnemonic,
      semanticChain: word_metadata_chain(semanticChain),
      reviewerNotes,
      confidence,
    }),
    warnings,
  };
  return word;
}

// Small adapters keeping buildMetadata's input shape independent of IngestWord.
function word_metadata_etymology(etymology: string): string | null {
  return isBlank(etymology) ? null : etymology.trim();
}
function word_metadata_chain(chain: string): string | null {
  return isBlank(chain) ? null : chain.trim();
}

/**
 * Parse a whole collection file into its header and word entries.
 * Unknown `##` blocks (none expected in the migration corpus) are surfaced as
 * words without Identity via warnings rather than dropped silently.
 */
export function parseVocabCollection(markdown: string): IngestCollectionFile {
  const header = parseCollectionHeader(markdown);
  const words: IngestWord[] = [];
  const matches = [...markdown.matchAll(WORD_HEADING_RE)];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? markdown.length) : markdown.length;
    words.push(parseWordBlock(markdown.slice(start, end)));
  }
  return { header, words };
}
