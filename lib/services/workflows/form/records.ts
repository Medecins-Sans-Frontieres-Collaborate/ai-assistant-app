import {
  FORM_LIMITS,
  FormDocument,
  FormFillWorkflowState,
  FormTemplate,
} from '@/types/formFill';
import { DataColumn } from '@/types/workflow';

import { withRowIds } from '../data/tableUtils';
import { PrefillUser } from './adminValues';
import {
  Clock,
  attachTemplate,
  setFieldDecision,
  setFieldValue,
} from './ledger';
import { fieldStatus } from './status';
import { coerceInput, formatValue, validateField } from './validation';

/**
 * Multi-record bridge with the data workflow (phase 3):
 *
 *  - rows → documents: one template filled for many entities. Each row of
 *    an imported table becomes a document; columns are matched to fields
 *    by id or normalized label and pre-filled as confirmed values (the
 *    row IS the user's word), leaving the rest for a fill run.
 *  - documents → table: every document's ledger as one row, so the data
 *    workflow's grid, record view, quality review and exports apply.
 *
 * Pure; the workspace wires the store and conversation creation.
 */

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Column id/name → field id, exact id first, then normalized label. */
export function matchColumnsToFields(
  columns: DataColumn[],
  template: FormTemplate,
): Map<string, string> {
  const byId = new Map(template.fields.map((f) => [f.id, f.id]));
  const byLabel = new Map(
    template.fields.map((f) => [normalize(f.label), f.id]),
  );
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const column of columns) {
    const fieldId =
      byId.get(column.id) ??
      byLabel.get(normalize(column.name)) ??
      byLabel.get(normalize(column.id));
    if (fieldId && !taken.has(fieldId)) {
      out.set(column.id, fieldId);
      taken.add(fieldId);
    }
  }
  return out;
}

export interface RowsToDocumentsResult {
  state: FormFillWorkflowState;
  created: number;
  /** Rows not turned into documents because the cap was reached. */
  skipped: number;
  matchedFieldIds: string[];
}

export function documentsFromRows(
  state: FormFillWorkflowState,
  template: FormTemplate,
  table: { columns: DataColumn[]; rows: Record<string, unknown>[] },
  options: { clock: Clock; prefillUser?: PrefillUser },
): RowsToDocumentsResult {
  const mapping = matchColumnsToFields(table.columns, template);
  const fieldById = new Map(template.fields.map((f) => [f.id, f]));
  let next = state;
  let created = 0;
  let skipped = 0;
  for (const row of table.rows) {
    if (next.documents.length >= FORM_LIMITS.MAX_DOCUMENTS) {
      skipped += 1;
      continue;
    }
    next = attachTemplate(next, template, {
      language: template.language ?? next.documents[0]?.language ?? 'English',
      clock: options.clock,
      prefillUser: options.prefillUser,
    });
    const docId = next.activeDocumentId;
    if (!docId) continue;
    created += 1;
    next = {
      ...next,
      documents: next.documents.map((doc) => {
        if (doc.id !== docId) return doc;
        let filled = doc;
        for (const [columnId, fieldId] of mapping) {
          const field = fieldById.get(fieldId);
          const raw = row[columnId];
          if (!field || raw === null || raw === undefined) continue;
          const text = String(raw);
          if (text.trim() === '') continue;
          const value = coerceInput(field, text);
          filled = setFieldValue(filled, fieldId, value, options.clock.now());
          // A cell that fails the field's own rules (a non-ISO date, an
          // option outside the list) is imported but NOT confirmed, so it
          // shows as partial with its issue instead of exporting verbatim.
          if (validateField(field, value).length > 0) {
            filled = setFieldDecision(
              filled,
              fieldId,
              'clear',
              options.clock.now(),
            );
          }
        }
        return filled;
      }),
    };
  }
  return {
    state: next,
    created,
    skipped,
    matchedFieldIds: [...mapping.values()],
  };
}

const DOCUMENT_COLUMN_ID = 'document_name';

function columnType(field: FormTemplate['fields'][number]): DataColumn['type'] {
  switch (field.type) {
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'boolean':
      return 'boolean';
    default:
      return 'text';
  }
}

export interface DocumentsTable {
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  nextRowId: number;
}

/**
 * One row per document; columns are the union of the documents' fields in
 * first-seen order, prefixed by a "Document" column naming the template.
 * Empty and N/A fields become null; lists join with "; ".
 */
export function tableFromDocuments(documents: FormDocument[]): DocumentsTable {
  const columns: DataColumn[] = [
    { id: DOCUMENT_COLUMN_ID, name: 'Document', type: 'text' },
  ];
  const seen = new Set<string>([DOCUMENT_COLUMN_ID]);
  for (const doc of documents) {
    for (const field of doc.template.fields) {
      const id = field.id;
      if (seen.has(id)) continue;
      seen.add(id);
      columns.push({
        id,
        name: field.label,
        type: columnType(field),
        required: field.required || undefined,
      });
    }
  }
  const rows = documents.map((doc) => {
    const row: Record<string, unknown> = {
      [DOCUMENT_COLUMN_ID]: doc.template.name,
    };
    for (const field of doc.template.fields) {
      const fill = doc.fields[field.id];
      const { status } = fieldStatus(field, fill);
      if (status === 'empty' || status === 'not_applicable') {
        row[field.id] = null;
        continue;
      }
      const value = fill?.value;
      if (Array.isArray(value)) row[field.id] = value.join('; ');
      else if (typeof value === 'number' || typeof value === 'boolean') {
        row[field.id] = value;
      } else row[field.id] = formatValue(value);
    }
    return row;
  });
  const withIds = withRowIds(rows, 0);
  return { columns, rows: withIds.rows, nextRowId: withIds.nextRowId };
}
