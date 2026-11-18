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

## Uploaded documents as page sheets

An uploaded document that keeps its file reference (`sourceDocument`) is shown
in the source pane as a file card followed by one sheet per page, instead of
one run of text.

- **File card** (`SourceDocumentCard`): name, page count, size (`size` on
  `TranslationSourceDocument`, when known) and a remove button, which clears
  the document and its text.
- **Sheets** (`SourcePageSheets`): each page is a card with its number as a
  label outside the text. A marker in the corner shows the page in view
  ("Page 12 of 409") and opens a field to jump to a page. Off-screen sheets
  are skipped with CSS `content-visibility`.
- **Which pages**: Quick and Reviewed show the pages loaded as source text;
  Whole document shows every page, because the file itself is translated.
- **Printed page counters** ("Page 3 / 409") are removed from the start or end
  of a sheet when at least half the pages carry one naming their own page
  (`stripPageCounters` in `lib/utils/shared/translation/pageSheets.ts`). This
  is display only: the text sent for translation is unchanged.
- **Editing**: sheets are read-only. "Edit as text" on the card switches to the
  text field (not offered in Whole document mode). Once the text no longer
  equals the loaded pages, the sheets are not offered, since they would show
  something other than what is translated.
- **After a reload** the pages are no longer in memory; the card offers "Show
  pages", which reads the stored file again.

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

## Text or Document, Quick or Reviewed

The toolbar offers two things to translate, and a row beneath it holds the
choices that belong to each:

| Choice      | Where         | Options                                                       |
| ----------- | ------------- | ------------------------------------------------------------- |
| What        | toolbar       | **Text** (the source pane) or **Document** (the uploaded PDF) |
| Layout      | row, Document | **Text only** (default) or **Preserve formatting**            |
| Translation | row           | **Quick** or **Reviewed**; not shown for Document > Text only |

- **State**: `mode` is still `quick`, `agentic` or `document`. Text and
  Document each keep their own depth: `textMode` remembers the text mode
  while in Document (absent means `agentic`), and `documentDepth` is the
  formatted layout's (absent means `quick`).
- **Document > Text only** is translated by the document service in one
  pass, so it has no Quick / Reviewed choice.
- **A PDF uploaded into Text** is read as text. A strip then offers
  "Translate as a document", which switches to Document with the file
  kept; "Keep as text" dismisses it for that file.
- **Upload document**: with OneDrive / SharePoint available to the person
  (the Microsoft 365 files flag and their connect opt-in), the button
  opens the chat's "Add to chat" picker, hosted (`AddToChatHost` in
  `components/Chat/ChatInput/AddToChatDialog.tsx`) with two sources, this
  device and OneDrive / SharePoint / Teams files, and the workspace's file
  types. A picked file is downloaded and loaded exactly as a device upload
  is. Without Microsoft 365 the button opens the system file dialog.
- **No target language**: Translate is not disabled for that alone. The
  language control is marked and says "Choose a target language to
  translate" while it is the only thing missing, and pressing Translate
  opens the picker (`languageMissing` / `askForLanguage` in the workspace).

## Document mode

For translating the uploaded PDF itself. It has two layouts, chosen in a row under the toolbar. The row
appears while the "Preserve formatting for PDFs" feature is on in
Admin > Workflows (under Translation; on by default). With the feature off
there is one layout and no row, and the server refuses the pipeline's
routes:

| Layout              | Default | What it does                                                                                                                      |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Text only           | yes     | Azure document translation of the whole file; read and corrected as text, page by page. Described in this section.                |
| Preserve formatting | no      | Each page is rebuilt with the translation in place. See [Document mode: preserve formatting](#document-mode-preserve-formatting). |

In the workspace code `documentMode` means the text layout and
`formattedMode` the other; exactly one is true in Document mode.

The text layout sends the PDF through document translation
(`/api/document-translation/translate`) and then reads the result page by
page.

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

## Document mode: preserve formatting

Rebuilds pages of a PDF with the translation laid out where the source text
was, a batch of pages at a time. The rules live in
`lib/utils/shared/translation/nativePdf.ts` (pipeline) and
`formattedDocument.ts` (screen); the screens are in
`components/Workflows/Translation/Formatted/`.

- **Steps**: every run does the same six steps in the same order (extract,
  analyze, translate, rebuild, verify, refit). Three accept an added
  instruction (analyze, translate, verify), which is appended to the step's
  rules and never replaces them. None can be skipped or reordered.
- **Where a translation may go** (rules stated once at the top of
  `browser-harness/scripts/pdf_native.py`, tested in `test_pdf_native.py`
  beside it):
  - _Panels_: a block's room stays inside the filled or outlined shape it
    sits in (a card, a table cell, a coloured box), and a paragraph in such
    a shape may use the shape's width.
  - _Clear space_: the page is drawn without its text and a room grows only
    until it meets something drawn: a rule, a box's edge, a picture.
  - _Alignment_: centred and right-aligned text is detected (stacked lines
    sharing a centre or right edge, or one line in the middle of its panel)
    and laid out the same way, in a room centred on the same axis.
  - _Peers_: blocks of one page in the same style (list items, the headings
    of a row of cards) are set at one size. When some must shrink, all take
    the smallest size; a block that would need less than 85% is left out of
    the group and reworded by the fix rounds instead.
- **Fix rounds** (the refit step, 0 to `NATIVE_PDF_MAX_REFIT_ROUNDS`): the
  visual check gets each page's picture plus its size and every block's
  font size, shrink and area, and prescribes one fix per finding: a shorter
  wording, a smaller font, or a move. `planLayoutFixes` holds them inside
  the automatic limits (`AUTO_MIN_SIZE_RATIO`, `AUTO_MAX_SHIFT`), the pages
  are laid out and checked again, and a page whose `layoutScore` got worse
  is put back and left alone. A smaller font goes to the block's peers too.
  Sizes and moves are returned as the run's
  `styles`, so they show in a block's Appearance box (marked "Adjusted")
  and can be changed or reset like a person's own.
- **Translation**: Quick (default) is one pass per page. Reviewed adds up to
  `NATIVE_PDF_MAX_REVIEW_ROUNDS` (3) rounds in which the draft is checked
  against the source. Glossaries apply in both; any target language works,
  custom ones included.
- **Routes** (all under `/api/document-translation/native`; 403
  `WORKFLOW_FEATURE_DISABLED` while the feature or the translation workflow
  is off in Admin > Workflows): `GET` reports availability and limits; `POST` runs the pipeline and
  streams one JSON line per step, then the result; `POST /render` lays the
  pages out again from edited text without translating anything;
  `POST /unit` rewrites one block (shorten, change as instructed, translate).
- **Batches and limits**: a document is translated in batches. Three
  numbers, set in Admin > Workflows under the feature, bound them: the
  pages a batch takes by default, the largest batch a person may raise it
  to (in the setup, "Pages per batch"), and the pages of one document that
  may be translated in total. Overrides give other numbers to named
  people, a mail domain or a directory attribute (person outranks
  attribute outranks domain). Compiled bounds in `WORKFLOW_FEATURES`
  (`lib/services/workflows/policy/types.ts`) hold whatever is saved.
- **Page states** (`planBatch` / `batchPageState`): each preview is in this
  batch, free to add, translated by an earlier batch, waiting for a later
  batch (this one is full), or over the document limit. Only the first two
  have a checkbox.
- **Requests**: one request takes `NATIVE_PDF_MAX_PAGES` (6) pages. A
  larger batch is sent as several requests in turn; what finished is kept
  if a later one fails or the person stops.
- **One result**: after a finished run the toolbar offers "Add pages". The
  new batch is joined to the earlier ones by `POST /render` with every
  batch's `unitsIds`, which returns one PDF of the whole document with the
  translated pages replaced, and one extraction id for later re-renders.
  A different target language starts over instead of adding.
- **Page list of a finished translation**
  (`Formatted/FormattedPageRail.tsx`): every page of the source, as the
  download will hold it. Translated pages show their rebuilt image; pages
  not translated are dimmed and marked, and open as their original; removed
  pages are greyed out with a way back. Untranslated pages have a tick box:
  "Select next N" ticks the next batch, and "Translate N pages" runs the
  ticked pages with the run's own depth and adds them
  (`planTickedBatch`; the same limits as the setup).
- **Removing pages from the download**: `run.removedPages` is what the
  person wants left out, `run.pdfRemovedPages` what the stored PDF leaves
  out (convention in `formattedDocument.ts`). A difference is a pending
  change in the same banner as edits; "Update the download" renders with
  `omitPages`, which the rebuild script applies last, so page numbers
  always mean source pages. A removed page keeps its translation, is never
  put in a batch, and the last page left cannot be removed (the render
  route answers 400 `NO_PAGES_LEFT`).
- **Enforcement**: the run route refuses more pages than a request or the
  person's largest batch; the render route refuses a result with more
  translated pages than the document limit (`DOCUMENT_PAGE_LIMIT`). The
  server keeps no count per document, so the limit holds per result, not
  across separate conversations.
- **State**: the run is stored in workflow state as `formattedRun` and
  holds every batch so far. It holds ids of the stored source and
  extraction, so a re-render needs nothing else from the server. A run
  belongs to the document it was made from.
- **Editing convention** (stated once, in `formattedDocument.ts`):
  `units[].translation` is what the last render shows; `edits[id]` is a
  pending change (`null` = keep as written) and exists only while it differs.
  Text is typed as plain text, on the page or in the block list; inline
  formatting is put back where its words survive (`retagEditedText`).
- **Zoom**: the page view zooms in steps from 50% to 250%
  (`PAGE_ZOOM_LEVELS`); 100% is the pane's width up to a normal page.
  Translated page images are made at 144 dpi so they stay readable zoomed
  in; the original is rendered again at the zoomed width.
- **A block's look** (`Formatted/FormattedBlockStyle.tsx`): font size,
  position and text colour of the selected block, in small steps.
  `run.styles[id]` is the look wanted, `run.pdfStyles[id]` the one on the
  page; a difference is a pending change like a text edit, counted once per
  block. The outline on the page moves at once; the page changes on
  re-render. `NativePdfUnitStyle` (in `nativePdf.ts`) states the move
  convention: points, +x right, +y down. The render route takes `styles`
  and drops anything invalid (`sanitizeUnitStyles`). In the rebuild script
  a size applies to the whole block (parts in another size keep their
  proportion, and a larger size lets the text use the space below it); a
  colour applies to the block's main text, while links and parts in their
  own colour keep it; a move stops at the page's edge.
- **Re-render**: edits wait in a banner until "Re-render pages". Every
  render starts from the original PDF and returns images of the changed
  pages only. The layout check afterwards is optional and covers only the
  pages that changed.
- **Broken character escapes**: a model now and then writes `\u0000e9`
  for "é", which would cut a block off where it is drawn. `callStructured`
  asks once more for such an answer and repairs what the second one still
  holds; the rules are in `lib/services/workflows/shared/modelTextRepair.ts`.
- **Layout check failures**: the check is advice about pages that are
  already built. A page whose check fails (for example on a dropped
  connection) is listed in `uncheckedPages` and the run still finishes.
- **Limits**: scanned pages have no text to rebuild and are left out;
  translated text is set in the closest installed font, not the document's
  own; JPEG 2000 images are missing from the page previews (not from the
  PDF); stopping keeps the requests of a batch that already finished and
  discards the one in progress; text that is not horizontal is not handled.

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

## Change requests

The user can ask for a change to a translation in words ("make it more
formal", "say tableta"). The request never rewrites the text: it comes back
as individual edits in the review column, each accepted or rejected on its
own.

- **Three ways in, one path.** The bar under the panes
  (`ChangeRequestBar`), a popover on highlighted text
  (`SelectionChangeRequest`) and the conversation rail all end in
  `runChangeRequest` in `TranslationWorkspace`.
- **Server.** `POST /api/workflows/translation/revise` takes the
  instruction, the source (optional: a scanned page has none), the
  translation, the target language, the glossaries, an optional
  `selection {text, start}` and the UI locale. It returns `{reply, edits}`
  from one structured call (`runTranslationChangeRequest`). A message that
  is a question returns a reply and no edits.
- **Where the edits live.** In the same `assessment` slot as quality
  assessment edits, marked by `assessment.request` (`criteria` is empty and
  `overallSummary` holds the reply). Accept, reject, undo, the highlights,
  the pending-suggestions dialog and, in Whole document mode, saving the
  page correction are therefore the assessment code paths, not copies.
  A request that produces no edits leaves the slot untouched.
- **Selections.** Edits must lie inside the selected passage (enforced in
  the prompt and by `sanitizeChangeEdits`) and are anchored with
  `stampSelectionAnchors`, so a phrase that also occurs elsewhere changes
  only where it was highlighted.
- **The rail.** `translationRailChat.sendRailMessage` parks the instruction
  in `workflowRailStore.workspaceRequests`; the workspace takes it, runs it
  and calls `settle(reply)`, which the rail posts as the assistant message.
  The shell mounts a workspace per layout and hides one with CSS, so only
  the copy on screen takes a request (`checkVisibility`). If no workspace
  takes it within `WORKSPACE_PICKUP_TIMEOUT_MS` the rail answers for itself.
- **Limits.** Instruction `MAX_CHANGE_INSTRUCTION_CHARS` (2,000), at most
  `MAX_CHANGE_EDITS` (20) edits, texts up to 60,000 characters. Runs debit
  the shared token budget like every workflow call.
