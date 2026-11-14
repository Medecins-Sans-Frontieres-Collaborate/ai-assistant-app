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

## Documents larger than one batch

A run takes at most 60,000 source characters. An uploaded document over
that is not rejected: `lib/utils/shared/translation/pageBatches.ts` splits
the extracted text into pages, the first batch of consecutive pages that
fits is loaded, and `SourcePageSelector` (a strip above the source pane)
lets the user type a page range or step to the previous/next batch. A
selection is applied only if it fits the budget.

- Workflow state keeps a **reference** (`sourceDocument`: name, blob url,
  last page, selected pages) plus the bounded source text, never the whole
  document. After a reload the pages are re-read on demand through
  `/api/file/process`, which is cached server-side.
- Splitting also removes the extractor's `--- Page N ---` markers, for small
  documents too.
- A file with no server copy (plain text read in the browser) or a single
  page over the budget still gets the "too long" message.

Whole-file, layout-preserving translation is the separate chat feature
(`/api/document-translation/*`). For PDFs it also offers:

- `GET /api/document-translation/pages/{jobId}?from=&to=`: source and
  translated text per page (built once, cached as a blob), at most 25 pages
  per read.
- `PUT /api/document-translation/pages/{jobId}`: the user's corrected text
  for one page (`text: null` clears it), stored as a blob.
- `GET /api/document-translation/export/{jobId}?format=docx`: the text
  version, one Word page per source page, corrections applied. The
  translated PDF itself is never modified.
- `feature.translation.pagesPerDay`: admin-configurable daily page
  allowance, charged per PDF page at submit and returned if the submission
  fails.

## Progress and the analysis strip

Work with distinct phases shows named steps (`Shared/Progress/ProgressSteps`)
instead of a bare spinner:

- **Reviewed run**: Analyzing, Translating, Reviewing, Done, at the top of
  the translation pane (`TranslationRunStatus`). The step comes from the
  run's latest activity key; the keys live in `TRANSLATION_ACTIVITY`
  (`lib/utils/shared/translation/runProgress.ts`), which the orchestrator and
  the workspace both import. The text is labelled "Draft" and faded until the
  last review round finishes.
- **Quick run**: one pass, so a progress bar and placeholder lines, no steps.
- **Assessment**: the quality column opens at once and lists the criteria
  being checked (`AssessmentProgress`). The assessment is a single request,
  so the criteria are shown in progress together, not one by one.
- **Upload**: Uploading, Reading text, Ready, in the source pane
  (`UploadProgress`), with Cancel.

Run, assessment and upload can each be stopped; a stop is not reported as an
error.

The paper trail (analysis, review rounds, glossary check) lives in
`AnalysisStrip` under the panes. It shows as a one-line header, expands on
click, and goes back to the header when a run completes. The expanded strip
is resizable by dragging its top edge or with the arrow keys (up grows).
Dismissing it and its height are **user preferences** in the settings store
(`translationAnalysisHidden`, `translationAnalysisHeight`), so they apply to
every translation; a dismissed strip is reopened from a pill in the
translation pane header.

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
