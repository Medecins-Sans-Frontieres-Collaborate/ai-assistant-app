/**
 * Form-fill workflow types (docs/DOCUMENT_FILL_ASSESSMENT.md).
 *
 * A template describes a fillable document — its sections, typed fields,
 * validation rules, a markdown `layout` with `{{field:<id>}}` slots for the
 * rendered output, and (when the template came from an upload) how the
 * original DOCX/PDF can be filled in place. A workflow conversation holds
 * one or more documents, each a template SNAPSHOT plus a per-field ledger;
 * every output (filled original, rendered document, copy view, provenance
 * document) is a projection of that ledger.
 */
import { StructureFieldType } from './structure';

/* ------------------------------------------------------------------ */
/* Template                                                            */
/* ------------------------------------------------------------------ */

export type FormFieldType = StructureFieldType | 'longtext' | 'list<longtext>';

export const FORM_FIELD_TYPES: readonly FormFieldType[] = [
  'text',
  'longtext',
  'number',
  'date',
  'boolean',
  'enum',
  'list<text>',
  'list<longtext>',
  'list<number>',
];

export interface FieldValidation {
  minChars?: number;
  maxChars?: number;
  minWords?: number;
  maxWords?: number;
  /** Regex source, deterministic; anchored by the validator. */
  pattern?: string;
  enumValues?: string[];
  min?: number;
  max?: number;
  /** ISO dates (YYYY-MM-DD). */
  dateAfter?: string;
  dateBefore?: string;
  /** Minimum list entries for `list<*>` fields. */
  minItems?: number;
  /** Semantic rule the model must judge, e.g. "must cite a baseline figure". */
  rubric?: string;
}

/** How a label-anchored DOCX value is placed relative to its label text. */
export type DocxTextPlacement =
  | 'after-label'
  | 'table-cell-right'
  | 'table-cell-below'
  | 'next-paragraph';

/** Where a value goes in the original file. Absent for hand-authored forms. */
export type FieldAnchor =
  | { kind: 'docx-control'; tag: string }
  | {
      kind: 'docx-text';
      /** Normalized label text as it appears in the document. */
      labelText: string;
      /** Which occurrence of that label (0-based) when it repeats. */
      occurrence: number;
      placement: DocxTextPlacement;
    }
  | { kind: 'pdf-field'; fieldName: string };

export interface FormSection {
  id: string;
  heading: string;
  guidance?: string;
}

export interface FormField {
  /** Slug, stable; the json_schema key and anchor key. */
  id: string;
  sectionId: string;
  label: string;
  type: FormFieldType;
  /** What the field asks for — prompt guidance and the ledger's help text. */
  description?: string;
  required: boolean;
  validation?: FieldValidation;
  examples?: string[];
  anchor?: FieldAnchor;
  /**
   * Admin-only controls (phase 2). Optional and absent by default — a
   * template without any of these behaves exactly like a user template.
   */
  admin?: {
    locked?: boolean;
    prefill?:
      | { kind: 'constant'; value: string }
      | {
          kind: 'user';
          attribute:
            | 'displayName'
            | 'email'
            | 'department'
            | 'jobTitle'
            | 'officeLocation';
        };
  };
}

/** How the original upload can be filled; decided at derive time. */
export type OriginalFillMode =
  | 'docx-controls'
  | 'docx-anchored'
  | 'pdf-acroform'
  | 'none';

export interface FormTemplateOriginal {
  /** `/api/file/<sha256>.<ext>` reference from the upload. */
  fileId: string;
  name: string;
  mime: 'docx' | 'pdf';
  fillMode: OriginalFillMode;
}

export interface FormTemplate {
  id: string;
  name: string;
  description?: string;
  /** Default output language (English name, e.g. "French"). */
  language?: string;
  sections: FormSection[];
  fields: FormField[];
  /** Markdown with `{{field:<id>}}` slots — the rendered-output skeleton. */
  layout: string;
  original?: FormTemplateOriginal;
  /**
   * Template-level rules judged by the validate pass (phase 2), e.g. "the
   * budget total must equal the sum of the line items". Free text.
   */
  rules?: string[];
  origin: 'user' | 'admin';
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export type FillStatus =
  | 'empty'
  | 'partial'
  | 'filled'
  | 'confirmed'
  | 'not_applicable';

export type FillConfidence = 'high' | 'medium' | 'low';

export type FieldValue = string | number | boolean | string[] | null;

export interface FieldProvenance {
  sourceId: string;
  /** Verbatim excerpt in the source's own language. */
  excerpt: string;
  /**
   * Set by the server when it looked the excerpt up in the source text:
   * true = found verbatim (typography and whitespace aside), false = not
   * found, so the excerpt is the model's claim and nothing more. Absent on
   * provenance recorded before verification existed, and on the drafter's
   * own items, which carry their verification on the item.
   */
  verified?: boolean;
}

export interface FieldFill {
  /**
   * The user's explicit decision, when there is one. The effective status
   * shown in the ledger is DERIVED (`fieldStatus` in status.ts) from this,
   * the value, validation and gaps — never stored.
   */
  decision?: 'confirmed' | 'not_applicable';
  value: FieldValue;
  /** Why it is only partial: what is missing, in the document's language. */
  gaps?: string;
  confidence?: FillConfidence;
  provenance: FieldProvenance[];
  /** The model stated this needs no source (e.g. a capital city). */
  generalKnowledge?: boolean;
  /** Result of the last rubric check (validate pass); absent = unchecked. */
  rubric?: { ok: boolean; note: string; checkedAt: string };
  updatedAt: string;
}

/** A template-level rule's verdict from the validate pass. */
export interface DocumentRuleResult {
  rule: string;
  ok: boolean;
  note: string;
}

export type FillSourceKind = 'file' | 'url' | 'search' | 'note' | 'm365';

/** Cap for search/M365 text kept in state (no re-fetch path for those). */
export const SOURCE_TEXT_STATE_CAP = 16_000;

export interface FillSourceRecord {
  id: string;
  kind: FillSourceKind;
  name: string;
  /** File reference for `file` sources — the text is re-fetched, not stored. */
  fileId?: string;
  url?: string;
  query?: string;
  chars: number;
  /** Detected language (English name) of the material, when known. */
  language?: string;
  addedAt: string;
  /** Localized reason a `url` source could not be retrieved. */
  error?: string;
  /**
   * Inline text for kinds with no re-fetch path (`search`, `m365`), capped
   * at SOURCE_TEXT_STATE_CAP. Files and pages are re-fetched instead.
   */
  text?: string;
  /** Citations for `search` sources. */
  citations?: Array<{ title: string; url: string }>;
}

/** Free-form ideas and rail answers; small enough to live in state. */
export interface FillNote {
  id: string;
  /** Mirrors the `note` source id so provenance can point at it. */
  sourceId: string;
  text: string;
  /** The question this note answers, when it is an answer. */
  questionId?: string;
  createdAt: string;
}

export type QuestionMode = 'general' | 'targeted';

export interface QuestionRecord {
  id: string;
  mode: QuestionMode;
  text: string;
  fieldIds: string[];
  status: 'open' | 'answered' | 'skipped';
  answerNoteId?: string;
  askedAt: string;
}

export interface FillRunRecord {
  id: string;
  at: string;
  modelId?: string;
  fieldIds: string[];
  sourceIds: string[];
  /** Proposals returned, by field. */
  proposedFieldIds: string[];
}

/** One proposed value awaiting review (the workspace's pending queue). */
export interface FieldProposal {
  id: string;
  fieldId: string;
  value: FieldValue;
  gaps?: string;
  confidence: FillConfidence;
  provenance: FieldProvenance[];
  generalKnowledge?: boolean;
  status: 'pending' | 'accepted' | 'rejected';
  runId: string;
}

export interface FormDocument {
  id: string;
  /** Snapshot taken on attach — templates evolve; a run must not drift. */
  template: FormTemplate;
  templateRef?: { origin: 'user' | 'admin'; id: string; updatedAt: string };
  /** Output language for THIS document (English name); fixed once filled. */
  language: string;
  fields: Record<string, FieldFill>;
  questions: QuestionRecord[];
  runs: FillRunRecord[];
  proposals: FieldProposal[];
  /** Verdicts of the template-level rules from the last validate pass. */
  ruleResults?: DocumentRuleResult[];
}

export interface FormFillWorkflowState {
  kind: 'form-fill';
  /** Cap ~10 (state budget). Empty until a template is attached. */
  documents: FormDocument[];
  activeDocumentId?: string;
  /** Metadata only; text is re-fetched. Shared by every document. */
  sources: FillSourceRecord[];
  notes: FillNote[];
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Limits (shared by client and server)                               */
/* ------------------------------------------------------------------ */

export const FORM_LIMITS = {
  MAX_FIELDS: 150,
  MAX_SECTIONS: 40,
  MAX_DOCUMENTS: 10,
  MAX_LAYOUT_CHARS: 60_000,
  MAX_VALUE_CHARS: 8_000,
  MAX_LIST_ITEMS: 50,
  MAX_SOURCES_PER_FILL: 12,
  MAX_NOTE_CHARS: 4_000,
  MAX_QUESTIONS_PER_ROUND: 3,
  MAX_RULES: 20,
  MAX_SEARCH_QUERY_CHARS: 300,
  /** Field id shape: slug, also safe as a json_schema property key. */
  FIELD_ID_PATTERN: /^[a-z][a-z0-9_]{0,39}$/,
} as const;
