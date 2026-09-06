# Vocab Observatory (vocab-ob)

An Obsidian-integrated vocabulary learning system: Obsidian textbook notes feed a SQLite-backed review app with FSRS scheduling, multi-track learning (L1/L2/L3), and AI-assisted content enrichment.

## Language

### Learning tracks

**L1**: The base vocabulary track. Entries follow a strict 9-section structure (Prototype, Mnemonic, Semantic Chain, etymology, examples, cefr, etc.).
_Avoid_: basic deck, word entry (too vague)

**L2**: The advanced track a word is promoted into after L1 mastery (L1_stability ≥ 21d, ≥5 reviews, last rating good/easy, no existing L2 entry). Carries FSRS scheduling inherited from L1.
_Avoid_: extension, enrichment (those describe content, not the track)

**L3**: A read-only context layer that consumes L2 progress to surface snippets elsewhere. Must never write to FSRS fields.
_Avoid_: suggestion feed

**Stub entry**: A word row containing only the lemma with no content (`definition_md = ''`). Never enters the review queue.
_Avoid_: empty card, placeholder

### Review scheduling

**Due deck**: Cards with `due_at <= now()` — used by review/zen modes.
_Avoid_: review queue (ambiguous with practice deck)

**Practice deck**: All non-suspended cards regardless of due date — used by cram/preview modes.

**Cram mode**: Bulk practice that must NOT write review_logs or update FSRS scheduling.

**Preview mode**: Pure browsing with no scoring or persistence.

**FSRS fields**: stability, difficulty, retrievability, state — writable only by L1/L2 flows; L3 reads are forbidden.

### Review card disclosure (L1 三层披露)

**Minimal seed (最小种子)**: The L1 content strategy — core meaning + morphology + etymology narrative + memory chain; dictionary-style piling is forbidden. Collocations/corpus/examples/synonym/antonym distinctions are L2-only and never appear on an L1 card.
_Avoid_: 网络层 as a historical term (Tier naming below is a 2026-09 UI invention, not the original design vocabulary)

**Answer tier (答案层 / Tier 0)**: The Short Definition (one-line fast-recognition meaning) plus the Core Definitions senses row (numbered senses with inline collocation snippets) shown beneath it. The tested content; always visible after flip.
_Avoid_: showing only the short definition (real entries carry 1-3+ senses); calling Core Definitions "dictionary piling" (it is capped at a few senses by design)

**Anchor tier (锚点层 / Tier 1)**: Prototype + Mnemonic rendered as low-visibility pills beside the answer; the 意象—助记 pair of the L1 三件套. Not test content. Single-line truncated.
_Avoid_: 提示, core meaning (duplicates the answer tier)

**Network tier (网络层 / Tier 2)**: Etymology Narrative + Semantic Chain + Morphology (root/family), collapsed by default, expandable on demand. Chinese-language chains per the 精修手则; word-source chronology stays in the etymology narrative, chains show semantic drift only.
_Avoid_: examples/例句 (words.examples is empty for imported L1 entries; example sentences are L2 corpus)

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
