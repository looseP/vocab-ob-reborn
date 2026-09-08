# Vocab Observatory (vocab-ob)

An Obsidian-integrated vocabulary learning system: Obsidian textbook notes feed a SQLite-backed review app with FSRS scheduling, multi-track learning (L1/L2/L3), and AI-assisted content enrichment.

## Language

### Learning tracks

**L1**: The base vocabulary track. Entries follow a strict 9-section structure (Prototype, Mnemonic, Semantic Chain, etymology, examples, cefr, etc.).
_Avoid_: basic deck, word entry (too vague)

**L2**: The advanced track a word is promoted into after L1 mastery (L1_stability ≥ 21d, ≥5 reviews, last rating good/easy, no existing L2 entry). Carries FSRS scheduling inherited from L1; product positioning is the long-term memory circulation station (长时记忆循环站) — sustained maintenance of application ability.
_Avoid_: extension, enrichment (those describe content, not the track)

**L3**: The personal material space (素材空间) — user-encountered real usage recorded as browsable sources: articles (incl. audio articles), long/difficult sentences from reading practice, exam translation content. Sources and words are many-to-many: one source marks many words, one word carries contexts from many sources. Navigation is bidirectional: word card → its contexts inside a source; source marker → back to the word. L3 is never scheduled — no cards, no FSRS; it only supplies read-only context to L1/L2 surfaces.
_Avoid_: suggestion feed; third learning track (L3 owns no scheduling)

**L3 source (L3 来源)**: One browsable user-imported material in the L3 material space — an article (incl. audio article), a long/difficult sentence, exam translation content. The capture unit for the material space.
_Avoid_: wordbook (a source is material, not a word collection)

**L3 context (L3 语境条目)**: One word's real-usage record captured inside an L3 source (original sentence/phrase + anchor position + optional note). Many-to-many with words; on review cards it renders only as a collapsed Tier 2 entry with click-through; full management/revisit lives on the word detail page.
_Avoid_: example sentence (an L2 corpus sentence is dictionary content; an L3 context is the user's own capture)

**Reading view (阅读视图)**: The L3 space surface that renders a source's stored full text, highlights exactly the positions the user captured — the union of occurrence offsets for that source (no tokenizer, no all-same-form matching; un-captured occurrences of the same word stay dark) — and links each highlight to the word detail page. The "from material back to word card" direction of bidirectional navigation. Highlight density grows with captures: the accumulation experience.
_Avoid_: full in-library word highlighting (TokenizerService-based dictionary-style highlighting is deferred); highlighting un-captured same-form matches (that reintroduces tokenization through the side door)

**Selection capture (圈记)**: Selecting text in the reading view to record an L3 context — the selection auto-expands to the containing sentence (light segmentation, no heavy model) or is kept as a phrase/collocation with a target-word confirmation. Words not yet in the library get a stub entry first (capture-first: no stability gate), then the context binds. Owner direct-write: trusted foundation surface, no proposal queue. **One sentence, many words (2026-09-08):** a sentence usually involves several words — capture is idempotent per anchor (same source + same position reuses the existing context and appends one occurrence per word; re-capturing the same word returns the existing occurrence). Multi-word highlights open a word picker instead of navigating to an arbitrary single word.
_Avoid_: batch import proposals (the /imports/raw-text proposal pipeline is for bulk/agent parsing, not this interaction); one-context-per-word duplicates (never create a second context row for the same anchor — append occurrences instead)

**Bookshelf (书架 / 来源列表)**: The L3 space's front door — a paginated list of the user's sources with type filter, title/content search, and sort (recent / most captured). The entry surface for material-driven retrieval; word-driven retrieval already lives in the word space, word detail pages, and review-card Tier 2. Sized for heavy use (2-3 imports/day): filter and search are core, not luxury.
_Avoid_: library (ambiguous with the vocabulary library); wordbook (a bookshelf lists materials, not word collections)

**Stub entry**: A word row containing only the lemma with no content (`definition_md = ''`). Never enters the review queue.
_Avoid_: empty card, placeholder

### Review scheduling

**Due deck**: Cards with `due_at <= now()` — used by review/zen modes.
_Avoid_: review queue (ambiguous with practice deck)

**Practice deck**: All non-suspended cards regardless of due date — used by cram/preview modes.

**Cram mode**: Bulk practice that must NOT write review_logs or update FSRS scheduling.

**Preview mode**: Pure browsing with no scoring or persistence.

**L2 Drill (辨析训练)**: The L2 track's own review mode (`sessions.mode = 'l2_drill'`) over the L2 due deck. Per-word two-step session: Step 0 discrimination (4-choice MCQ; correct→good / incorrect→again; a wrong answer ends the session) then Step 1 production (user writes a sentence and self-assesses passed/weak — zero FSRS writes). The production step's reference example prefers the user's L3 contexts, falling back to corpus.
_Avoid_: progressive mode (the superseded "P" design that rode the L1 queue); treating production self-assessment as schedulable

**FSRS fields**: stability, difficulty, retrievability, state — writable only by L1/L2 flows; L3 reads are forbidden.

### Review card disclosure (L1 三层披露)

**Minimal seed (最小种子)**: The L1 content strategy — core meaning + morphology + etymology narrative + memory chain; dictionary-style piling is forbidden. Collocations/corpus/examples/synonym/antonym distinctions are L2-only and never appear on an L1 card. **L3 contexts are a distinct concept** — user-captured real usage with anchor/network nature, not dictionary piling — and may appear on an L1 card only as a collapsed Tier 2 entry.
_Avoid_: 网络层 as a historical term (Tier naming below is a 2026-09 UI invention, not the original design vocabulary)

**Answer tier (答案层 / Tier 0)**: The Short Definition (one-line fast-recognition meaning) plus the Core Definitions senses row (numbered senses with inline collocation snippets) shown beneath it. The tested content; always visible after flip.
_Avoid_: showing only the short definition (real entries carry 1-3+ senses); calling Core Definitions "dictionary piling" (it is capped at a few senses by design)

**Anchor tier (锚点层 / Tier 1)**: Prototype + Mnemonic rendered as low-visibility pills beside the answer; the 意象—助记 pair of the L1 三件套. Not test content. Single-line truncated.
_Avoid_: 提示, core meaning (duplicates the answer tier)

**Network tier (网络层 / Tier 2)**: Etymology Narrative + Semantic Chain + Morphology (root/family), collapsed by default, expandable on demand. Chinese-language chains per the 精修手则; word-source chronology stays in the etymology narrative, chains show semantic drift only. May also carry a lightweight **L3 context** entry (single-line original sentence + source title, click-through), collapsed by default to protect the <5s L1 pace.
_Avoid_: examples/例句 as L2 corpus (words.examples is empty for imported L1 entries; static corpus sentences are L2-only and never render on an L1 card). L3 contexts are the sanctioned exception: they are the user's own captures, not dictionary content.

### Content enrichment

**Candidate pool**: Agent-generated L2 content stored with `is_active = false`. Never displayed until adopted.
_Avoid_: draft (implies versioning), pending (implies automatic promotion)

**Adopt (采纳)**: Activate a candidate pool entry — activates content, refreshes PlazaCache, reschedules L2. Row-level, all-or-nothing at proposal time.
_Avoid_: save (save is item-level, see below)

**Save (保存)**: Item-level append of selected candidate items into an L2 row; unselected items are preserved as hidden, not dropped.
_Avoid_: adopt (adoption is the whole-candidate action)

**Hide (隐藏)**: Move one generation unit of an active L2 row into `content.hiddenItems` (JSONB wrapper). Reversible via restore; data is never deleted.
_Avoid_: remove, delete (those are destructive)

**Reject (驳回)**: Hard-delete a candidate pool entry. Irreversible.

### Notes

**Textbook note**: The Obsidian-imported `words.body_md`. Read-only in the app; never written back to Obsidian.
_Avoid_: note (ambiguous with annotation)

**Annotation**: A word's user-authored notes — a set of **note entries**. Private, DB-only; never written back to Obsidian.
_Avoid_: comment, highlight (highlights are a separate legacy table)

**Note entry (笔记条目)**: One discrete user note row for a word (a short insight with a timestamp). Created from the word detail page or review-card quick capture; edited in place. **Hide** exits display reversibly; **Delete** hard-deletes (detail page only, confirmation-protected).
_Avoid_: treating 快速笔记 as a separate system (card quick capture just inserts an entry)

**Note hide (笔记隐藏)**: Move a note entry out of display non-destructively; reversible via restore. Available on the review card and the detail page.
_Avoid_: remove, delete (those are destructive)

**Note delete (笔记删除)**: Hard-delete a note entry. Destructive and irreversible; detail page only, behind a confirmation — the review card never performs irreversible operations.
_Avoid_: using delete where hide suffices

## Relationships

- A **Word** has exactly one **Textbook note** (imported, read-only) and zero or more **note entries** (its Annotation set)
- A **Word** is in at most one track (**L1** or **L2**) at a time; L1→L2 promotion is one-way
- A **Word** is marked in zero or more **L3 sources**; an **L3 source** marks one or more words (many-to-many via L3 contexts)
- A **Word** has zero or more **Candidate pool** entries and zero or more active **L2 content** rows (one per field)
- An **L2 content** row contains items; **Save** selects a subset, **Hide** removes items from display non-destructively
- **Cram**/**Preview** read the **Practice deck**; **review**/**zen** read the **Due deck**

## Example dialogue

> **Dev:** "When the user unchecks some candidate items and hits 保存, what happens to the unchecked ones?"
> **Reviewer:** "They move to **Hidden items** — never dropped. 保存 is item-level and non-destructive; only 驳回 deletes."

## Flagged ambiguities

- "note" meant both the Obsidian import and user annotations — resolved: **Textbook note** vs **Annotation** are distinct; word_annotations table is legacy and superseded.
- "corpus" vs "example" for the same L2 field — resolved: storage/API use `corpus`, Composer UI tab label is `example`; UI filters must map example→corpus.
- "采纳" vs "保存" for candidate pool actions — resolved: 采纳 = whole-candidate activation; 保存 = item-level append with hidden preservation.
- "quick note (快速笔记)" on the review card back — resolved: it inserts a **note entry** (same Annotation set as the detail page); not a third note system.
- Single-document notes with a version chain (snapshot/auto-save, `note_revisions` time machine) — retired 2026-09-06 in favor of **note entries**; the document model's overwrite-conflict class disappears at the root. Non-destructive **hide** and destructive **delete** coexist as two distinct semantics (hide on card + detail; delete on detail only). Existing document notes migrate to entries.
- "例句" ambiguity between L2 corpus and L3 contexts — resolved: L2 corpus 例句 (dictionary-style static content) never render on an L1 card; **L3 contexts** (user-captured real usage from the personal material space) may render on L1/L2 review cards only as collapsed Tier 2 entries with click-through. Full L3 management/revisit lives on the word detail page.
- L3 capture admission gate (pre-agreed 2026-08-22 in capture.service.ts enablement rules: a word must meet the L2 transition standard before binding a context) — resolved 2026-09-07: **no stability gate, capture-first**. Any word (incl. stub entries) records the source/context/occurrence trio at the moment of encounter; noise is handled by collapsed Tier 2 display + hide/restore semantics, not by gating. The code-comment enablement rules must be rewritten when L3 capture ships.
- Audio article media modeling (never explicitly modeled in any historical draft; video player was deferred to Phase 4 in v2.2) — resolved 2026-09-07: **model per the audio-revisit design, implement text-first then audio**. The L3 source model treats a media reference (media ref + millisecond anchors) as first-class, unified for audio/video; MVP ships pure-text import, audio playback revisit (HTML5 audio seek + text highlight) follows as a fast-follow. The full video player (subtitle overlay, iframe embedding) stays deferred — the ASR scope-cut rationale still holds.
- L3 capture entry paths (three material types vs scattered historical paths: text import + annotation rendering, CapturePage, golden entries, learning assets) — **revised 2026-09-07 (supersedes the same-day earlier resolution)**: the reading view + selection capture (圈记) is promoted INTO the MVP as the space's core interaction — paste-import article full text (owner direct-write, trusted foundation surface), reading view highlights only already-captured words by occurrence offsets, selection auto-expands to the containing sentence (light segmentation) or records a phrase/collocation with target-word confirmation, words not in the library get stubs first. The **Bookshelf (complete version c)** is also in MVP: user is a heavy player (2-3 imports/day ≈ 700-1000 sources/year), so type filter + title/content search + sort are core entry surface. Still deferred: TokenizerService full in-library highlighting, URL fetching (公众号反爬), audio playback. CapturePage reserved-field enablement and golden quick entries remain in MVP as complementary paths.
