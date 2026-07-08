# L1 Vocabulary Markdown Format

## Purpose

This document defines the review-friendly Markdown source format for the L1-only vocabulary copy.

L1 is the fast recognition layer: when a learner sees a word, they should recall the core meaning within a few seconds. This format deliberately excludes L2 content such as collocations, corpus examples, synonym distinctions, and antonym distinctions.

The Markdown file is intended for human review first. It can later be parsed or manually converted into the project `words` table fields used by L1.

## File Shape

Recommended shape:

- One Markdown file can contain many words.
- Each word starts with a level-2 heading: `## word-slug`.
- YAML front matter inside each word block is not required. Use simple labeled sections for easier review.
- Keep each word short enough to scan in 30-60 seconds.

## L1 Word Template

```md
## abandon

### Identity

- lemma: abandon
- title: abandon
- pos: v
- ipa: /əˈbændən/
- cefr: B2
- aliases: abandons, abandoned, abandoning

### Short Definition

放弃；抛弃；离弃

### Core Definitions

1. 放弃；停止继续
   - en: to stop doing, supporting, or trying to achieve something
   - priority: 1
   - tags: core

2. 抛弃；离弃
   - en: to leave someone or something behind permanently
   - priority: 2
   - tags: person, object

### Prototype

abandon = 丢下不管 / 不再继续

### Morphology

- prefix:
- root:
- suffix:
- family: abandoned, abandonment

### Mnemonic

- type: story
- text: a band on：乐队散了，大家放弃演出。

### Semantic Chain

leave -> give up -> stop supporting -> no longer care for

### Reviewer Notes

- Keep.
- Core meaning is clear.
```

## Field Rules

### Identity

Required:

- `lemma`: canonical base form.
- `title`: display form, usually same as `lemma`.
- `pos`: compact part of speech, such as `n`, `v`, `adj`, `adv`.

Optional but recommended:

- `ipa`: pronunciation.
- `cefr`: A1-C2 level if available.
- `aliases`: inflections, spelling variants, or common alternate forms.

Maps to:

- `words.lemma`
- `words.title`
- `words.pos`
- `words.ipa`
- `words.cefr`
- `words.aliases`

### Short Definition

Required.

Rules:

- One line is best.
- Prefer Chinese or Chinese-first bilingual wording.
- Keep only the fast recognition meaning.
- Avoid detailed usage, examples, and subtle synonym comparison.

Maps to:

- `words.short_definition`

### Core Definitions

Required.

Rules:

- Usually 1-3 senses.
- Sort by recognition priority, not dictionary completeness.
- `priority: 1` is the main sense shown first.
- Each sense should be short enough for quick review.
- Tags are optional and should be coarse, such as `core`, `formal`, `spoken`, `person`, `object`, `abstract`.

Maps to:

- `words.core_definitions`

Suggested JSON shape after conversion:

```json
[
  {
    "sense_id": "abandon.v.01",
    "pos": "v",
    "zh": "放弃；停止继续",
    "en": "to stop doing, supporting, or trying to achieve something",
    "priority": 1,
    "tags": ["core"]
  }
]
```

### Prototype

Optional but recommended.

Rules:

- One compact mental model for the word.
- Use this to capture the original image, core metaphor, or one-glance meaning.
- Do not put usage examples here.

Maps to:

- `words.prototype_text`

### Morphology

Optional but recommended for roots, affixes, and word families.

Rules:

- Leave blank if unknown.
- Do not invent roots.
- `family` should contain only clearly related forms.

Maps to:

- `words.metadata.morphology`

Suggested JSON shape after conversion:

```json
{
  "prefix": null,
  "root": null,
  "suffix": null,
  "family": ["abandoned", "abandonment"]
}
```

### Mnemonic

Optional.

Rules:

- Keep it short.
- Prefer useful memory anchors over jokes.
- Allowed types: `root`, `sound`, `image`, `story`, `contrast`.

Maps to:

- `words.metadata.mnemonic`

Suggested JSON shape after conversion:

```json
{
  "type": "story",
  "text": "a band on：乐队散了，大家放弃演出。"
}
```

### Semantic Chain

Optional but recommended.

Rules:

- Use `->` to show meaning movement.
- Keep 3-6 nodes.
- This is for L1 recognition only, not L2 usage analysis.

Maps to:

- `words.metadata.semantic_chain`

Suggested JSON shape after conversion:

```json
["leave", "give up", "stop supporting", "no longer care for"]
```

### Reviewer Notes

Optional.

Rules:

- For human review only.
- Do not import into authoritative word content unless intentionally mapped later.
- Useful tags: `Keep`, `Needs rewrite`, `Too long`, `Move to L2`, `Reject`.

## What L1 Markdown Must Not Contain

Do not include these as L1 sections:

- `Collocations`
- `Corpus`
- `Examples`
- `Synonyms`
- `Antonyms`
- `Usage Difference`
- `L3 Contexts`
- Long source quotations

If these appear during review, move them to L2/L3 later instead of importing them into L1.

## Conversion Mapping

| Markdown section | Target field |
| --- | --- |
| `Identity.lemma` | `words.lemma` |
| `Identity.title` | `words.title` |
| `Identity.pos` | `words.pos` |
| `Identity.ipa` | `words.ipa` |
| `Identity.cefr` | `words.cefr` |
| `Identity.aliases` | `words.aliases` |
| `Short Definition` | `words.short_definition` |
| `Core Definitions` | `words.core_definitions` |
| `Prototype` | `words.prototype_text` |
| `Morphology` | `words.metadata.morphology` |
| `Mnemonic` | `words.metadata.mnemonic` |
| `Semantic Chain` | `words.metadata.semantic_chain` |
| `Reviewer Notes` | review-only, not imported by default |

## Hash Boundary

L1 content hash should be computed only from:

- `definition_md`
- `core_definitions`
- `prototype_text`
- `metadata.morphology`
- `metadata.mnemonic`
- `metadata.semantic_chain`

L1 Markdown review notes and L2 sections must not affect `l1_content_hash`.

## Recommended Review Checklist

- The word has one clear fast-recognition meaning.
- The first core definition is the most important meaning.
- The entry does not include L2 usage or synonym distinction content.
- Morphology and mnemonic are useful, not forced.
- Semantic chain explains the meaning movement without becoming an essay.
- The entry can be understood in under one minute.

## Full Example

```md
## sustain

### Identity

- lemma: sustain
- title: sustain
- pos: v
- ipa: /səˈsteɪn/
- cefr: B2
- aliases: sustains, sustained, sustaining

### Short Definition

维持；支撑；承受

### Core Definitions

1. 维持；使持续
   - en: to make something continue over time
   - priority: 1
   - tags: core, abstract

2. 支撑；支持
   - en: to support the weight or existence of something
   - priority: 2
   - tags: support

3. 遭受；承受
   - en: to suffer or experience damage, loss, or injury
   - priority: 3
   - tags: damage

### Prototype

sustain = 从下面托住，让它不断

### Morphology

- prefix: sus-/sub-
- root: tain/ten
- suffix:
- family: sustainable, sustained, sustenance

### Mnemonic

- type: root
- text: ten/tain = hold，sustain 就是持续 hold 住。

### Semantic Chain

hold -> support -> keep going -> endure

### Reviewer Notes

- Keep.
- Sense 3 may need L2 examples later, but L1 wording is enough.
```
