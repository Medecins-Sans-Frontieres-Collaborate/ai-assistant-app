# Translation workflow: languages, quality assessment & revision model

How the translation workflow (`conversationType: 'translation'`) selects
target languages, evaluates quality, and manages revisions. Server side:
`app/api/workflows/translation/{route,assess/route}.ts` →
`lib/services/workflows/translation/translationOrchestrator.ts`. UI:
`components/Workflows/Translation/`.

## Target languages

- **Catalog** (`lib/utils/shared/translation/languages.ts`): ~115 curated
  languages (ISO 639-1/3), deliberately independent of the app's 53 UI
  locales, with explicit MSF-relevant coverage (Pashto, Dari, Kurmanji,
  Sorani, Tigrinya, Rohingya, Dinka, Sango, …).
- **User-added languages**: the picker's "Add '<query>'" row creates a
  custom language (settingsStore v27 `customLanguages`), flagged
  "Added by you" and accompanied by a hint that the AI attempts any
  language with unvetted quality (transparent-consequences principle).
- The server receives the language as a **display label** (≤80 chars,
  free text by design), not a locale code.

## Working translation & editable output

`TranslationWorkflowState.finalText` is the **working translation** —
streamed output, user-pasted text, or manual edits, whichever came last.
The target pane's Edit toggle swaps in a textarea, which also lets users
paste their own translation and assess it without ever running translate.
Editing (and re-translating) is **blocked while unresolved suggested
edits exist** — re-anchoring edits against freeform typing is fragile, and
silently discarding them destroys paid-for model work; Reject-all is the
one-click escape.

## Quality assessment (MQM-derived)

Six dimensions from the MQM (Multidimensional Quality Metrics) framework —
accuracy, fluency, terminology, style, locale conventions, audience —
defined once in `lib/utils/shared/translation/qualityCriteria.ts` (UI
labels + English prompt rubrics). Users run all or a subset (checkboxes).
`POST /api/workflows/translation/assess` makes one strict structured call
returning a 1–5 rating + summary per criterion and up to 20 proposed
edits `{criterion, before, after, reason, severity(minor|major)}` —
glossary violations are rubric-marked as always ≥ major.

## Revision model

- **Initial agentic run**: analyze → translate → ≤3 auto-applied review
  rounds (unchanged), but each round now carries a **computed**
  sentence-diff of what it changed (`computeSegmentChanges` — honest by
  construction, never model-self-reported), rendered as before→after
  chips in the analysis panel.
- **Post-initial assessment**: proposed edits are PENDING and reviewed
  individually — inline word diffs (`diffWords`) with the model's
  reasoning, Accept/Reject per edit plus Accept-all/Reject-all. Accepting
  locates `before` **at apply time** (first occurrence in the current
  working text — `lib/utils/shared/translation/editApplication.ts`);
  unlocatable edits become `unapplicable` (suggestion-only). Bulk accept
  applies leftmost-first with re-location so earlier applications can't
  corrupt later offsets. Resolved edits stay visible with their outcome —
  the assessment slot is the decision record; a new run replaces it and is
  blocked while anything is pending.

### Separation of concerns in the layout

The assessment renders in a **dedicated review column beside the target
pane** (opens automatically when an assessment lands; collapsible, with a
"Show review (N pending)" reopener in the assess strip; pending edits sort
above resolved ones). The bottom strip holds ONLY the pre-run paper trail
(analysis + auto-applied round changes). Rationale: the edit queue is
actionable work the user must see and resolve; the paper trail is history.
Mixing them in one collapsed strip buried the interactive part.

## Language picker

`components/UI/LanguagePicker.tsx` is viewport-aware: it prefers opening
above its trigger but flips below when the space above can't fit it (the
workspace trigger sits at the top of the window), clamps horizontally,
and repositions on scroll/resize while open.
