/**
 * Conversation workflow types.
 *
 * A conversation may be created as a specialized "workflow" (translation,
 * document writing, data analysis, map). It remains an ordinary conversation
 * in the sidebar and store, but renders a specialized window instead of the
 * standard chat. The type is fixed at creation time: it is only ever set on
 * an empty conversation and never changed afterward.
 */

export const CONVERSATION_WORKFLOW_TYPES = [
  'translation',
  'document',
  'data-analysis',
  'map',
] as const;

export type ConversationWorkflowType =
  (typeof CONVERSATION_WORKFLOW_TYPES)[number];

export function isConversationWorkflowType(
  value: unknown,
): value is ConversationWorkflowType {
  return (
    typeof value === 'string' &&
    (CONVERSATION_WORKFLOW_TYPES as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* Translation                                                         */
/* ------------------------------------------------------------------ */

export interface TranslationTrickyTerm {
  term: string;
  issue: string;
  suggestion: string;
}

export interface TranslationAmbiguity {
  text: string;
  readings: string[];
}

/** Structured pre-analysis produced before the agentic translation pass. */
export interface TranslationAnalysis {
  trickyTerms: TranslationTrickyTerm[];
  ambiguities: TranslationAmbiguity[];
  register: string;
  notes: string;
}

export interface TranslationReviewIssue {
  excerpt: string;
  problem: string;
  severity: 'minor' | 'major';
  suggestion: string;
}

/** Computed sentence-level change from an auto-applied review round. */
export interface TranslationRoundChange {
  before: string;
  after: string;
}

export interface TranslationReviewRound {
  round: number;
  verdict: 'approve' | 'revise';
  issues: TranslationReviewIssue[];
  /** What the round actually changed (computed diff, not model-reported). */
  changes?: TranslationRoundChange[];
}

/* ------------------------------------------------------------------ */
/* Translation quality assessment (MQM-derived)                        */
/* ------------------------------------------------------------------ */

export type TranslationCriterionId =
  | 'accuracy'
  | 'fluency'
  | 'terminology'
  | 'style'
  | 'localeConventions'
  | 'audience';

export interface TranslationCriterionRating {
  criterionId: TranslationCriterionId;
  /** 1 (unusable) … 5 (publication-ready). */
  rating: number;
  summary: string;
}

/** One granular proposed change to the working translation. */
export interface TranslationEdit {
  criterion: TranslationCriterionId;
  /** Exact substring of the translation at assessment time. */
  before: string;
  after: string;
  reason: string;
  severity: 'minor' | 'major';
}

export type TranslationEditStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'unapplicable';

export interface TranslationPendingEdit extends TranslationEdit {
  id: string;
  status: TranslationEditStatus;
  resolvedAt?: string;
}

/**
 * The latest quality-assessment run, including resolved edit statuses as
 * the record of decisions. A new run replaces the slot; starting one is
 * blocked while unresolved (pending) edits exist.
 */
export interface TranslationAssessment {
  id: string;
  criteria: TranslationCriterionRating[];
  overallSummary: string;
  edits: TranslationPendingEdit[];
  createdAt: string;
}

export interface GlossaryEntry {
  source: string;
  target: string;
  note?: string;
}

/**
 * A reusable terminology glossary for the translation workflow. Stored in
 * settingsStore (user-scoped, localStorage) like prompts/tones; sent inline
 * with each translation request — the server holds no glossary state.
 */
export interface TranslationGlossary {
  id: string;
  name: string;
  sourceLang?: string;
  targetLang?: string;
  entries: GlossaryEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A user-added translation target language (settingsStore). The AI will
 * attempt any language name; these are flagged as user-added in the
 * picker because quality is unvetted.
 */
export interface CustomTranslationLanguage {
  id: string;
  name: string;
  createdAt: string;
}

/** Selected translation target: catalog entry or user-added. */
export interface TranslationTargetLanguage {
  id: string;
  /** Display label sent to the server (e.g. "Pashto (پښتو)"). */
  label: string;
  custom?: boolean;
}

export interface TranslationWorkflowState {
  kind: 'translation';
  sourceText: string;
  sourceLang?: string;
  /** Legacy locale-code field; superseded by targetLanguage. */
  targetLang?: string;
  targetLanguage?: TranslationTargetLanguage;
  /** References a glossary in settingsStore; the entries travel per-request. */
  glossaryId?: string;
  mode: 'quick' | 'agentic';
  analysis?: TranslationAnalysis;
  rounds: TranslationReviewRound[];
  /**
   * The WORKING translation: the streamed result, a user-pasted text, or
   * the edit-toggle output — whichever came last. Assessment edits apply
   * against this exact string (no normalization anywhere).
   */
  finalText?: string;
  assessment?: TranslationAssessment;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Shared review shapes (workflow-agnostic; translation types satisfy  */
/* them structurally — TranslationCriterionId is a string subtype)     */
/* ------------------------------------------------------------------ */

export type ReviewEditStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'unapplicable';

/** One granular proposed change to a working text, reviewable as a diff. */
export interface ReviewEdit {
  id: string;
  /** Built-in criterion id or 'custom:<uuid>'. */
  criterion: string;
  /** Exact substring of the assessed text. */
  before: string;
  after: string;
  reason: string;
  severity: 'minor' | 'major';
  status: ReviewEditStatus;
  resolvedAt?: string;
}

export interface ReviewCriterionRating {
  criterionId: string;
  /** 1 (unusable) … 5 (publication-ready). */
  rating: number;
  summary: string;
}

/* ------------------------------------------------------------------ */
/* Document writing                                                    */
/* ------------------------------------------------------------------ */

export interface DocumentSpecSection {
  heading: string;
  guidance?: string;
  required: boolean;
}

/**
 * A reusable document format template (e.g. a SitRep): ordered sections
 * with per-section guidance. Stored in settingsStore; sent inline with
 * requests (stateless server, like glossaries).
 */
export interface DocumentSpec {
  id: string;
  name: string;
  description?: string;
  sections: DocumentSpecSection[];
  generalGuidance?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A user-defined quality criterion (e.g. "brand considerations"),
 * usable in assessments and revision rounds alongside the built-ins.
 */
export interface DocumentCustomCriterion {
  /** Always 'custom:<uuid>' — collision-proof vs built-in ids. */
  id: string;
  name: string;
  /** English rubric text injected into prompts. */
  rubric: string;
  createdAt: string;
  updatedAt: string;
}

export type DocumentBuiltinCriterionId =
  | 'grammarSpelling'
  | 'consistency'
  | 'clarity'
  | 'sensitivity'
  | 'specAdherence'
  | 'toneAdherence';

/** Legacy field from the earlier English-centric profile shape. */
export type SpellingVariety = 'US' | 'UK' | 'mixed' | 'unknown';

/** Agentic pre-assessment of the current document. */
export interface DocumentProfile {
  docType: string;
  audience: string;
  purpose: string;
  register: string;
  toneSummary: string;
  /** Detected document language (English name, e.g. "French"). */
  language?: string;
  /**
   * Orthographic/regional conventions observed, incl. inconsistencies
   * (e.g. "UK English throughout", "mixes en-US and en-GB spellings",
   * "Brazilian Portuguese orthography").
   */
  conventionNotes?: string;
  /** Legacy (pre-language-general profiles); no longer written. */
  spellingVariety?: SpellingVariety;
  notes: string;
  /** stringHash of the profiled markdown — staleness check. */
  contentHash: number;
  createdAt: string;
}

/**
 * The latest document quality assessment. Edits apply against the
 * `docMarkdown` snapshot taken at assessment time; the editor and
 * generate/revise are blocked while edits are pending, so the snapshot
 * cannot drift from the document under review.
 */
export interface DocumentAssessment {
  id: string;
  criteria: ReviewCriterionRating[];
  overallSummary: string;
  edits: ReviewEdit[];
  /**
   * Markdown snapshot the edits locate/apply against — always the FULL
   * document (a selection-scoped assessment constrains proposals to the
   * excerpt, which is a substring, so application is unchanged).
   */
  docMarkdown: string;
  /** What was assessed; absent = document (pre-scope records). */
  scope?: 'document' | 'selection';
  /** The assessed excerpt, for display, when scope is 'selection'. */
  selectionText?: string;
  /** Label snapshots for custom criterion ids (survive rename/delete). */
  labels?: Record<string, string>;
  createdAt: string;
}

export interface DocumentReference {
  fileId: string;
  name: string;
  url: string;
  /** Size of the extracted text; the text itself is re-fetched, not persisted. */
  chars: number;
}

export interface DocumentRevisionRecord {
  id: string;
  instruction: string;
  at: string;
}

export interface DocumentWorkflowState {
  kind: 'document';
  title: string;
  /** Canonical document HTML. Capped; see updateWorkflowState size guard. */
  docHtml: string;
  references: DocumentReference[];
  revisions: DocumentRevisionRecord[];
  /** Attached document spec (settingsStore.documentSpecs). */
  specId?: string;
  /** Attached voice/tone (settingsStore.tones). */
  toneId?: string;
  /** Pinned spelling variety; absent = 'auto' (detected, mixing flagged). */
  spellingVariety?: 'auto' | 'US' | 'UK';
  profile?: DocumentProfile;
  assessment?: DocumentAssessment;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Data analysis                                                       */
/* ------------------------------------------------------------------ */

export type DataColumnType = 'text' | 'number' | 'date' | 'boolean';

/**
 * Display-only numeric formatting captured at import/conversion time.
 * Cell values are always stored as plain numbers; this only drives how
 * the grid renders them ("$1,234.56", "1.234,56 €").
 */
export interface DataColumnFormat {
  /** Currency token as captured ('$', '€', 'R$', 'USD', 'kr'). */
  currency?: string;
  /** Token placement relative to the number; absent = prefix. */
  currencyPosition?: 'prefix' | 'suffix';
  /** Separator convention: 'us' = 1,234.56, 'eu' = 1.234,56. */
  numberStyle?: 'us' | 'eu';
}

export interface DataColumn {
  id: string;
  name: string;
  type: DataColumnType;
  /** Required field: missing values enforce the missingFieldPolicy. */
  required?: boolean;
  /** Numeric display format; only meaningful on 'number' columns. */
  format?: DataColumnFormat;
  /**
   * Derived-column formula in canonical id-ref form, e.g.
   * "[cases] / [population] * 1000". Presence makes the column derived:
   * always type 'number', never required, cells computed at render time
   * (never persisted into rows) and read-only in every edit surface.
   */
  formula?: string;
}

export interface DataSourceRecord {
  id: string;
  kind: 'csv' | 'json' | 'xlsx' | 'paste' | 'extraction' | 'photo';
  name: string;
  addedAt: string;
  rowCount: number;
  /**
   * Internal image refs ('/api/file/{sha}.{ext}') for photo sources —
   * NEVER base64 (the workflow state has a ~200KB budget). Fetched
   * lazily for thumbnails and the QC pane; one ingest batch = one
   * source, so multi-photo batches carry all their refs here.
   */
  imageFileUrls?: string[];
  /** Rids of the rows this source appended (set inside applyTable). */
  rowIds?: string[];
}

export interface DataOperationRecord {
  id: string;
  engine: 'client' | 'llm';
  instruction: string;
  at: string;
  explanation?: string;
}

/**
 * Deterministic per-column statistics (see columnStats.profileTable) —
 * computed exactly client-side and passed to assessment/chat prompts as
 * ground truth the model must not re-estimate.
 */
export interface ColumnProfile {
  columnId: string;
  total: number;
  missing: number;
  distinct: number;
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  minDate?: string;
  maxDate?: string;
  /** Top values by count; only for low-cardinality text/boolean columns. */
  topValues?: Array<{ value: string; count: number }>;
}

export type DataBuiltinCriterionId =
  | 'validity'
  | 'consistency'
  | 'duplicates'
  | 'plausibility';

/**
 * One proposed data-quality fix. Extends the shared ReviewEdit so the
 * shared review components render it unchanged; `before`/`after` are the
 * canonical formatted cell values (see tableUtils formatCell), and the
 * edit anchors by stable row id (`rid`) instead of a text substring.
 */
export interface DataQualityEdit extends ReviewEdit {
  kind: 'cell' | 'deleteRow';
  /** Stable row id (__rid) of the target row. */
  rid: string;
  /** Target column id; absent for deleteRow edits. */
  columnId?: string;
}

/**
 * The latest data-quality assessment. Unlike the text workflows the grid
 * is NOT blocked while edits are pending: rid anchoring plus the
 * `before`-value check degrades stale edits to 'unapplicable' gracefully.
 * Wholesale row replacement (import/transform/undo) clears the slot.
 */
export interface DataQualityAssessment {
  id: string;
  criteria: ReviewCriterionRating[];
  overallSummary: string;
  edits: DataQualityEdit[];
  /** What was assessed ('ingest' = auto-check of newly added rows). */
  scope: 'table' | 'filtered' | 'selection' | 'ingest';
  /** True when only a deterministic sample of the scoped rows was sent. */
  sampled: boolean;
  assessedRowCount: number;
  totalRowCount: number;
  createdAt: string;
}

export interface DataAnalysisWorkflowState {
  kind: 'data-analysis';
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  sources: DataSourceRecord[];
  operations: DataOperationRecord[];
  /** Monotonic counter for stable row ids (__rid); absent = pre-rid state. */
  nextRowId?: number;
  assessment?: DataQualityAssessment;
  /** 'record' renders a single-record form view; absent = 'table'. */
  viewMode?: 'table' | 'record';
  /**
   * How ingestion treats rows missing REQUIRED fields: 'strict' drops
   * them, 'flag' imports and flags the cells, 'lenient' imports
   * silently. Absent = 'flag'.
   */
  missingFieldPolicy?: 'strict' | 'flag' | 'lenient';
  /** Auto-run a quality check on LLM-ingested rows; absent = true. */
  autoCheckOnIngest?: boolean;
  /**
   * User dismissed the attribute-matrix transpose suggestion for the
   * current table; cleared when a new source is imported.
   */
  transposeSuggestionDismissed?: boolean;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Map                                                                 */
/* ------------------------------------------------------------------ */

export type MapFeatureConfidence = 'high' | 'medium' | 'low';

/**
 * How central the location is to the source material. A report about
 * Venezuela that mentions Syria in one sentence yields Venezuela `primary`
 * and Syria `mention` — a passing reference is not the same as a document
 * genuinely about several distant places.
 */
export type MapFeatureProminence = 'primary' | 'secondary' | 'mention';

/**
 * Spatial granularity of the place. site/city render as point markers;
 * district/region/country render as approximate extent circles so a
 * country centroid never masquerades as a precise location.
 */
export type MapFeatureGranularity =
  | 'site'
  | 'city'
  | 'district'
  | 'region'
  | 'country';

/** Variable-precision ISO date: 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'. */
export type PartialIsoDate = string;

export interface MapFeature {
  id: string;
  name: string;
  description: string;
  lat: number;
  lon: number;
  confidence: MapFeatureConfidence;
  confidenceReason: string;
  category: string;
  /**
   * Event dates from the material, precision encoded in the string shape.
   * All optional: features saved before dates existed are simply undated.
   * Interpret only via lib/utils/shared/date/partialDate.ts.
   */
  eventStart?: PartialIsoDate;
  eventEnd?: PartialIsoDate;
  /** The situation began and is still continuing ("since March…"). */
  eventOngoing?: boolean;
  /** Optional for features created before prominence existed (= primary). */
  prominence?: MapFeatureProminence;
  /** Optional for features created before granularity existed (= city). */
  granularity?: MapFeatureGranularity;
  /** ISO 3166-1 alpha-2 of the containing country; empty when unknown. */
  countryCode?: string;
  /** Name of the broader mapped place this belongs to (usually a country). */
  parentName?: string;
  /** Model-estimated extent radius (km) for area features; 0 for points. */
  approxRadiusKm?: number;
  /** Which source run produced this feature. */
  sourceId?: string;
}

export interface MapSourceRecord {
  id: string;
  name: string;
  addedAt: string;
  featureCount: number;
  /** How the material arrived. Absent on records saved before this field. */
  kind?: 'text' | 'file' | 'search' | 'chat';
  /** The web search query, for kind 'search'. */
  query?: string;
}

/**
 * A relationship between two mapped features the material states —
 * movement of people/teams, cause and effect, supply lines, historical
 * references. `kind` is free text (model-controlled, like `category`).
 */
export interface MapConnection {
  id: string;
  fromId: string;
  toId: string;
  kind: string;
  description: string;
  /** Which source run produced this connection. */
  sourceId?: string;
}

export interface MapWorkflowState {
  kind: 'map';
  features: MapFeature[];
  sources: MapSourceRecord[];
  /** Optional for states saved before connections existed. */
  connections?: MapConnection[];
  view?: { lat: number; lon: number; zoom: number };
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Union                                                               */
/* ------------------------------------------------------------------ */

/**
 * Workflow-specific persisted state. `kind` MUST equal the conversation's
 * `conversationType`; `updateWorkflowState` in conversationStore enforces
 * this. Keep payloads small: metadata, references, and bounded text only —
 * large blobs belong in the file infrastructure.
 */
export type WorkflowState =
  | TranslationWorkflowState
  | DocumentWorkflowState
  | DataAnalysisWorkflowState
  | MapWorkflowState;
