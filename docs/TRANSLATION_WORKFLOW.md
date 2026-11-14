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

## Whole-document mode

A third mode beside Quick and Reviewed. It sends the uploaded PDF through
document translation (`/api/document-translation/translate`), which keeps the
layout, and then reads the result page by page.

- **Availability** (`wholeDocumentEligibility`): a PDF kept on the server and a
  target language that document translation supports. Custom languages and
  other formats are refused with a message; glossaries and review rounds do
  not apply and the glossary control is disabled.
- **State**: only a job reference (`documentJob`) is stored in workflow state.
  Page text is fetched five pages at a time and cached in memory.
- **Progress**: Uploaded, Translating, Preparing pages, Ready, shown in the
  translation pane with time since submission. The job is followed while the
  workspace is mounted, in any mode, and resumes after a reload. After 15
  failed status checks in a row checking stops and "Check again" is offered.
- **Pane ownership**: the page in view is placed in `finalText`, so editing,
  quality assessment and suggested edits work on a page as they do on pasted
  text. The text-mode result is set aside in `textModeResult` and restored on
  leaving the mode. The convention is documented once, in
  `lib/utils/shared/translation/documentMode.ts`.
- **Corrections**: any change to the page (typing or an accepted suggestion)
  is saved as that page's correction after a 700 ms pause, and immediately
  when the page is turned, the mode is left or the workspace closes. Text
  equal to the machine translation removes the correction ("Restore").
- **Downloads**: the translated PDF (original layout, without corrections)
  and the text version DOCX (with corrections).
- **Limits**: the daily page allowance is charged by the translate route; the
  toolbar shows pages left today when limits are enforced. Translating a
  finished document again asks first, since it charges the pages again.
- **Leaving a page with suggestions pending**: turning the page or leaving
  the mode opens the accept all / reject all dialog first, because
  suggestions belong to the page they were made for.
- **Stated limits**: a line says attached glossaries are not applied, and the
  introduction, the progress pane and the translate-again dialog say a
  started document translation cannot be stopped.

## OCR for scanned PDFs

`POST /api/file/ocr` reads a stored PDF with Azure Document Intelligence
(`prebuilt-read`, the client shared with grants and agent indexing).

- **When it is offered**: a PDF with no extractable text gets an offer in the
  source pane instead of an error; a PDF whose text is sparse
  (`looksLikeSparseText`: under 120 characters per page, or text on fewer than
  half the pages) gets a suggestion strip; any loaded PDF has a "Read with
  OCR" button. Nothing runs until the user confirms on the offer, which states
  the cost. Offers appear only when the server reports OCR as configured
  (`ocrAvailable` on `/api/file/process` responses).
- **Cost control**: the file's pages are charged to `feature.ocr.pagesPerDay`
  before analysis and refunded when OCR fails, is cancelled, or finds no
  text. One request reads at most `MAX_OCR_PAGES` (500). A file whose pages
  cannot be counted is refused rather than analysed unmetered.
- **Result**: text in the extractors' `--- Page N ---` format, written to the
  file's text cache. `/api/file/process` therefore returns the OCR text for
  that file afterwards, which is what page selection re-reads after a reload.
- **Configuration**: `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and
  `AZURE_DOCUMENT_INTELLIGENCE_KEY`. The resource is regional; see the
  residency note in `lib/services/documentIntelligence/client.ts`.
- **Scanned PDF to whole-document mode**: the no-text offer also has
  "Translate whole document", shown whether or not OCR is configured.
  Document translation reads scanned pages itself, so the file reference is
  kept with `noText: true`, the source text is left empty and the mode
  switches to Whole document. In the reader the source side of such a page
  has no text, so quality assessment is unavailable for it; reading the file
  with OCR first gives a source to compare against.
