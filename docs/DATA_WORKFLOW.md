# Data workflow: row identity, profiling, quality review, scope, insights, photo ingestion & schema-first structure

How the data-analysis workflow (`conversationType: 'data-analysis'`)
manages tabular data. Server: `app/api/workflows/data/{extract,transform,
assess,chat}/route.ts`. UI: `components/Workflows/Data/`. Pure logic:
`lib/services/workflows/data/`. Guiding split: **everything deterministic
(stats, filters, aggregation) is computed client-side exactly; the LLM is
reserved for semantics** (extraction, transforms, quality judgments,
grounded Q&A).

## Stable row identity

Every row carries a reserved `__rid` key (`tableUtils.ROW_ID_KEY`): a
base36 rendering of a monotonic counter (`nextRowId` on the workflow
state) — ~15 bytes/row at the 5,000-row cap, vs ~47 for uuids. Collision-
proof (`toColumnId` strips leading underscores, so no imported header can
produce it) and leak-proof (export and all LLM prompts iterate `columns`;
`stripRowIds` covers the transform request). Ids are assigned at the
`applyTable` chokepoint in `DataWorkspace`; pre-rid persisted states heal
via a one-shot backfill effect on mount. Full-table transform results get
FRESH ids (row correspondence isn't guaranteed); scoped transforms
preserve ids positionally. Row selection and the grid's `getRowId` are
rid-based, so selection survives sorting and filtering.

## Deterministic column profiling

`columnStats.profileTable` computes per-column stats in one pass:
missing count, distinct count, min/max/mean/median (numbers), date range,
and — for low-cardinality (≤20 distinct) text/boolean columns — the FULL
value→count table (the profile popover shows the head; value-set filters
and the chat digest use the whole list). Surfaced per column via the
header stats icon (`ColumnProfilePopover`) and fed to the assessment
prompt and rail digest as ground truth the model must not re-estimate.

## Filters & working scope

Ephemeral per-column filters (`filtering.ts`, AND across columns), type-
driven UI (`ColumnFilterPopover`): number/date ranges, value checkboxes
for low-cardinality columns, contains otherwise. The grid shows
`visibleRows` with a "Showing N of M" footer.

LLM operations always run against an EXPLICIT scope (`ScopeChip`,
translated from the document workflow's rule): all / filtered (N) /
selected (K), auto-picking the narrowest. **Scoped transforms** send only
the scoped rows with a same-shape contract — same row count and order,
cell edits and new columns allowed, nothing else — validated server-side
(`SCOPED_SHAPE_MISMATCH` otherwise; the client table stays untouched).
Merge-back (`scopedMerge.ts`) is positional: scoped rows keep their rids,
out-of-scope rows get `null` for new columns. Row-count-changing
operations (dedupe, aggregation) are directed to full-table scope.

## Data-quality assessment

Four built-in criteria (`lib/utils/shared/data/qualityCriteria.ts`):
**validity**, **consistency** (categorical variants — 'M'/'Male'/
'Hombre'), **duplicates**, **plausibility**. Completeness is deliberately
NOT a criterion — missing % is a computed stat the prompt receives
instead. `/api/workflows/data/assess` (sync JSON) sends the scoped rows
(≤300; larger scopes are stride-sampled deterministically and the prompt

- review panel say so), full-table stats, and a strict schema
  (`assessSchema.ts`) whose edits anchor by **rid + columnId** with a
  `kind` of `cell` or `deleteRow` — deleteRow is in scope precisely because
  rid anchoring makes duplicate-row removal a one-line filter. The route
  drops edits referencing unknown rids/columns.

Fixes are reviewed in the shared review column (`AssessmentPanel`, same
as translation/document; `EditSuggestionCard` grew an optional
`locationLabel` — "row 3f · Amount"). Accepting applies via
`qualityApplication.ts`: locate row by rid, apply iff the cell still
formats to the proposed `before` (canonical `formatCell` — the ONE
stringifier shared by grid, prompts, apply, and digest), else the edit
degrades to `unapplicable`. Unlike the text workflows the grid is NOT
blocked while edits are pending — rid anchoring makes stale edits safe —
but wholesale row replacement (import/transform/undo via `applyTable`)
clears the assessment.

## Insights (deterministic charts)

`aggregate.ts` (group-by count/sum/mean with top-30 truncation flag,
20-bin histogram, date series with stride downsampling) drives a
collapsible `InsightsPanel` between grid and transform bar, operating on
the VISIBLE rows so filters pay off immediately. Charts are hand-rolled
SVG (`components/Workflows/Data/charts/` — shared `ChartFrame` + bar/
histogram/line; no charting dependency), `<title>` tooltips, labeled for
screen readers.

## Data-aware rail chat

The registry's `railSend` override (map pattern) routes the conversation
rail to `/api/workflows/data/chat`: a streamed answer grounded in a
digest (`chatPrompts.buildDataDigest`) of schema + exact full-table stats
(incl. complete value→count tables for low-cardinality columns — most
"how many X" questions get exact answers even from a sample) + a
deterministic sample of ≤150 rows with rids + total counts, token-bounded
at ~20k. **Read-only by design**: no mutation sentinel; the assistant is
instructed to flag sample-derived estimates, cite rows by rid, and direct
change requests to the transform bar — the single transactional,
validated, undoable write path.

## Photo → data (vision)

`/api/workflows/data/photo` turns photographed forms/tables into
structured data. The client downscales each photo
(`client/utils/downscaleImage.ts`: EXIF-aware decode, ≤2048px JPEG,
white-fill — the app's first image-processing util), uploads via
`FileUploadService.uploadImage` (user-namespaced image bucket; pre-warms
the client base64 LRU), and sends only the internal
`/api/file/{sha}.{ext}` refs. The route validates refs against a strict
sha256 pattern, converts blobs to data URLs server-side
(`getBlobBase64String` — ownership enforced by the user-namespaced blob
path), and makes ONE vision call for the whole batch
(`callStructured` now accepts `ChatCompletionContentPart[]`;
`resolveVisionWorkflowModelId` guarantees a vision-capable model).

Two modes: **extract** fills the existing schema (nulls for unstated —
same contract as text extraction); **infer** (empty table) proposes the
structure AND values — `{kind: 'record'|'table', columns
(name/type/required), rows, notes}`. `kind: 'record'` means "one filled
form per photo" and switches the workspace to **record view**
(`RecordView`: the same columns×rows model rendered as an editable
vertical form; single-record JSON export emits the flat object). A
photo batch is ONE source (`DataSourceRecord.kind: 'photo'`,
`imageFileUrls`, plus `rowIds` — injected inside `applyTable`, where
rids are assigned). The **sources strip** shows every source; clicking
a photo chip opens the **QC pane** (zoomable photo, right pane —
exclusive with the review pane) while the grid filters to that photo's
rows: manual value-by-value checking against the original.

## Schema-first ingestion & required fields

`SchemaEditor` (inline panel; "Define structure" from the empty state)
creates or reshapes columns — name, type, `required` — via the pure
`schemaEdit.applySchemaChanges` (rename keeps the id; retype re-coerces
with a converted-cells report; deletes strip row keys). Documents and
photos then pull data INTO the structure (extract prompts list required
fields as guidance — never as an excuse to invent values).

Missing-field permissiveness (`missingFieldPolicy`, default 'flag') is
enforced deterministically client-side at every ingest chokepoint
(`requiredFields.enforceMissingFieldPolicy`): **strict** drops
incomplete rows with a report; **flag** imports and marks them;
**lenient** imports silently. The live scan
(`missingRequiredCells`, whole-table, memoized) paints red cell flags
in grid and record views; pending quality edits paint amber. A "N
flags" chip summarizes both.

## Agentic ingest checks

After an LLM-mediated ingest (photo/extraction — never file/paste),
when `autoCheckOnIngest` isn't off and the policy isn't lenient, the
workspace automatically assesses the NEW rows (source `rowIds` →
scoped rows, default criteria, `scope: 'ingest'`) and populates the
same review queue — accept/reject cell fixes and duplicate deletions,
with amber flags on the affected cells. Auto-checks are best-effort:
a failure surfaces as a notice, never blocks the data.

## Deferred

`engine: 'code'` (Foundry code interpreter) remains the documented v1.1
item; the transform route still rejects it explicitly
(`ENGINE_UNAVAILABLE`).
