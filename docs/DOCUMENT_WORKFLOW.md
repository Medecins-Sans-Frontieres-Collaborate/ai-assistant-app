# Document workflow: specs, quality assessment & revision model

How the document workflow (`conversationType: 'document'`) writes to
format specs, assesses quality, and manages granular revisions. Server:
`app/api/workflows/document/{route,assess/route}.ts` →
`lib/services/workflows/document/documentOrchestrator.ts`. UI:
`components/Workflows/Document/`. The review machinery (edit application,
assessment schema, review-column components) is shared with the
translation workflow — see `lib/utils/shared/review/editApplication.ts`,
`lib/services/workflows/shared/assessmentSchema.ts`, and
`components/Workflows/Shared/Review/`.

## Document specs

Reusable format templates (settingsStore v28 `documentSpecs`): an ordered
section list `{heading, guidance?, required}` plus freeform general
guidance — structured so prompt injection is deterministic and the
spec-adherence assessor can name specific missing/misordered sections.
Managed inline (`SpecManager`, GlossaryManager pattern), attached per
conversation (`specId`), and sent inline with generate/revise/assess
requests (stateless server).

## Tones

The app's existing Tones (`settingsStore.tones`) attach per conversation
(`toneId`); `{name, voiceRules, examples}` travels inline and becomes a
system-prompt block for writing and a tone-adherence criterion for
assessment.

## Quality criteria

Built-ins (`lib/utils/shared/document/qualityCriteria.ts`):

- **Grammar & spelling** (default on) — **language-general**: correct for
  the document's language (any language); any internally consistent
  regional convention or orthography is acceptable — inconsistent MIXING
  of conventions is the error. The profile-detected language and
  convention notes feed the rubric; there is no pinned-variety control
  (US/UK was only ever one example of the general rule).
- **Consistency** (default on) — terminology/naming/formatting coherence.
- **Clarity** (default on).
- **Sensitivity** (available, default OFF) — inclusive,
  conflict/humanitarian-sensitive wording.
- **Spec adherence** / **Tone adherence** — only offered while a
  spec/tone is attached (auto-selected on attach).

**Custom criteria** (settingsStore v28 `documentCriteria`,
`custom:<uuid>` ids): user-named rubrics ("brand considerations",
"organizational language") injected verbatim into assessment prompts and
— along with selected built-ins — into generate/revise runs as
`qualityGuidance` blocks, making custom revision rounds possible without
new endpoints. Assessments snapshot custom labels so renames/deletions
don't orphan the record.

## Agentic pre-assessment (document profile)

A cheap structured call characterizes the document — type, audience,
purpose, register, tone, **language** (any language; feedback — summaries
and edit reasons — is written in the document's own language), and
orthographic **convention notes** (incl. inconsistency observations) —
shown in the `DocumentProfilePanel` strip. Runs automatically after
upload-as-basis and lazily before an assessment when the profile is
missing or stale (staleness = `stringHash(docMarkdown)` mismatch). Folded
into the one assess route: `criteria: []` is a profile-only run.

## Direct editing & upload as basis

The editor is always present — a new document conversation is immediately
typeable (an empty-document hint bar offers "Start from an existing
document": upload → extracted text → `autoConvertToHtml` → the editable
document, followed by a profile run; hidden once content exists). Spec
and tone pickers render only when the corresponding collections are
non-empty; the manage buttons are the add paths.

## Selection scope

Highlighting text in the editor switches the working scope, which is
ALWAYS explicit via a scope chip in both the assess strip and the
composer ("Scope: full document" vs a blue "Scope: selection — …
(N words)" with a clear ✕). The selection is the editor's plain-text
rendering of the range — advisory context, not a byte-exact markdown
substring:

- **Revise**: the instruction applies only to the excerpt; the stream
  returns just the revised excerpt, which the client splices into the
  exact editor range (`RichTextEditorHandle.replaceRange`) — no streaming
  preview for scoped runs (atomic replace on completion).
- **Assess**: ratings/summaries describe the selected region only, and
  edit proposals are constrained to it — but each `before` is still
  copied verbatim from the FULL document markdown, so the snapshot-apply
  machinery is unchanged. The review column shows a "Selection" badge for
  scoped assessments.

## Revision model

Assessment produces up to 20 granular edits reviewed in the shared
review column (pending-first queue, inline word diffs, reasons,
accept/reject + bulk actions). **Edits apply against a markdown
snapshot** (`assessment.docMarkdown`, taken via `htmlToMarkdown` at
assessment time): each accept applies to that snapshot and regenerates
`docHtml` via `markdownToHtml` — conversion during review is only ever
md→html, so turndown↔marked round-trip drift cannot compound. The editor,
composer, and re-assess are **blocked while edits are pending**
(reject-all is the escape hatch), which makes mid-review drift
structurally impossible. A full generate/revise run clears the previous
assessment.
