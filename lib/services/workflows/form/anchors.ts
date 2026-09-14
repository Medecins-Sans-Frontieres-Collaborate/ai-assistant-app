import {
  FieldAnchor,
  FormField,
  FormFieldType,
  OriginalFillMode,
} from '@/types/formFill';

import { DocxControl } from './docxFill';
import { DocxTextSlot } from './docxTextAnchors';
import { PdfFieldInfo } from './pdfFill';

/**
 * Anchor assignment at derive time: matches the derived fields to the
 * addressable slots found in the original (DOCX content controls or PDF
 * AcroForm fields) so the export can fill in place. Pure; the report it
 * returns is shown to the user before the template is saved, so "can this
 * be filled in place?" is never a surprise at export.
 */

export interface AnchorReport {
  fillMode: OriginalFillMode;
  /** Slots in the original that matched no field. */
  unmatchedSlots: string[];
  /** Fields that got no anchor. */
  unanchoredFieldIds: string[];
  anchoredCount: number;
}

interface Slot {
  key: string;
  /** Human text to match on: alias/label/placeholder/field name. */
  labels: string[];
  kind: 'text' | 'checkbox' | 'choice' | 'other';
  options?: string[];
}

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(' ')
      .filter((t) => t.length > 1),
  );
}

/** Jaccard over word tokens; exact normalized equality scores 1. */
function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = tokens(na);
  const tb = tokens(nb);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  const union = ta.size + tb.size - common;
  return union === 0 ? 0 : common / union;
}

function fieldKind(type: FormFieldType): Slot['kind'] {
  if (type === 'boolean') return 'checkbox';
  if (type === 'enum') return 'choice';
  return 'text';
}

function kindCompatible(field: FormField, slot: Slot): boolean {
  const fk = fieldKind(field.type);
  if (slot.kind === 'other') return false;
  if (slot.kind === 'checkbox') return fk === 'checkbox';
  if (fk === 'checkbox') return false;
  return true;
}

/**
 * Greedy best-match assignment: every (field, slot) pair is scored, pairs
 * are taken best-first, and a field or slot is used once. A field's own id
 * (a slug) and label both count, so a control tagged `project_title`
 * matches the field derived from "Project title".
 */
function assign(
  fields: FormField[],
  slots: Slot[],
  threshold: number,
): Map<string, Slot> {
  const pairs: Array<{ fieldId: string; slot: Slot; score: number }> = [];
  for (const field of fields) {
    if (field.anchor) continue;
    for (const slot of slots) {
      if (!kindCompatible(field, slot)) continue;
      let best = 0;
      for (const label of slot.labels) {
        best = Math.max(
          best,
          similarity(field.label, label),
          similarity(field.id.replace(/_/g, ' '), label),
        );
      }
      if (best >= threshold)
        pairs.push({ fieldId: field.id, slot, score: best });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedFields = new Set<string>();
  const usedSlots = new Set<string>();
  const result = new Map<string, Slot>();
  for (const pair of pairs) {
    if (usedFields.has(pair.fieldId) || usedSlots.has(pair.slot.key)) continue;
    usedFields.add(pair.fieldId);
    usedSlots.add(pair.slot.key);
    result.set(pair.fieldId, pair.slot);
  }
  return result;
}

const MATCH_THRESHOLD = 0.5;

export function anchorDocxFields(
  fields: FormField[],
  controls: DocxControl[],
): { fields: FormField[]; report: AnchorReport } {
  const slots: Slot[] = [];
  const seen = new Set<string>();
  for (const control of controls) {
    if (seen.has(control.key)) continue;
    seen.add(control.key);
    slots.push({
      key: control.key,
      labels: [control.alias, control.tag?.replace(/[_-]/g, ' '), control.text]
        .filter((l): l is string => !!l && l.trim() !== '')
        .slice(0, 3),
      kind:
        control.kind === 'checkbox'
          ? 'checkbox'
          : control.kind === 'dropdown'
            ? 'choice'
            : 'text',
      options: control.options,
    });
  }
  return finish(
    fields,
    slots,
    (slot): FieldAnchor => ({
      kind: 'docx-control',
      tag: slot.key,
    }),
    'docx-controls',
  );
}

export function anchorPdfFields(
  fields: FormField[],
  pdfFields: PdfFieldInfo[],
): { fields: FormField[]; report: AnchorReport } {
  const slots: Slot[] = pdfFields.map((f) => ({
    key: f.name,
    // Field names like "topmostSubform[0].Page1[0].Name[0]" carry the label
    // in their last segment; expose both so either can match.
    labels: [f.name, lastSegment(f.name).replace(/[_-]/g, ' ')],
    kind:
      f.kind === 'checkbox'
        ? 'checkbox'
        : f.kind === 'radio' || f.kind === 'dropdown' || f.kind === 'optionlist'
          ? 'choice'
          : f.kind === 'text'
            ? 'text'
            : 'other',
    options: f.options,
  }));
  return finish(
    fields,
    slots,
    (slot): FieldAnchor => ({
      kind: 'pdf-field',
      fieldName: slot.key,
    }),
    'pdf-acroform',
  );
}

/**
 * Label-anchored DOCX (no content controls): slots are label paragraphs
 * with an empty cell/paragraph beside them. Matching is on the label text
 * only, so the threshold is a little higher than for controls.
 */
export function anchorDocxText(
  fields: FormField[],
  slots: DocxTextSlot[],
): { fields: FormField[]; report: AnchorReport } {
  const bySlotKey = new Map<string, DocxTextSlot>();
  const slotList: Slot[] = slots.map((slot) => {
    const key = `${slot.labelText}#${slot.occurrence}`;
    bySlotKey.set(key, slot);
    return { key, labels: [slot.labelText], kind: 'text' as const };
  });
  return finish(
    fields,
    slotList,
    (slot): FieldAnchor => {
      const source = bySlotKey.get(slot.key)!;
      return {
        kind: 'docx-text',
        labelText: source.labelText,
        occurrence: source.occurrence,
        placement: source.placement,
      };
    },
    'docx-anchored',
  );
}

function lastSegment(name: string): string {
  const withoutIndex = name.replace(/\[\d+\]/g, '');
  const parts = withoutIndex.split('.');
  return parts[parts.length - 1] ?? name;
}

function finish(
  fields: FormField[],
  slots: Slot[],
  toAnchor: (slot: Slot) => FieldAnchor,
  mode: OriginalFillMode,
): { fields: FormField[]; report: AnchorReport } {
  if (slots.length === 0) {
    return {
      fields,
      report: {
        fillMode: 'none',
        unmatchedSlots: [],
        unanchoredFieldIds: fields.map((f) => f.id),
        anchoredCount: 0,
      },
    };
  }
  const assigned = assign(fields, slots, MATCH_THRESHOLD);
  const anchored = fields.map((field) => {
    const slot = assigned.get(field.id);
    if (!slot) return field;
    const next: FormField = { ...field, anchor: toAnchor(slot) };
    // A choice slot with options tells us the allowed values better than
    // the document text did.
    if (slot.options && slot.options.length > 0 && field.type !== 'boolean') {
      next.type = 'enum';
      next.validation = {
        ...(field.validation ?? {}),
        enumValues: slot.options,
      };
    }
    return next;
  });
  const usedSlots = new Set([...assigned.values()].map((s) => s.key));
  return {
    fields: anchored,
    report: {
      fillMode: assigned.size > 0 ? mode : 'none',
      unmatchedSlots: slots
        .filter((s) => !usedSlots.has(s.key))
        .map((s) => s.key),
      unanchoredFieldIds: anchored.filter((f) => !f.anchor).map((f) => f.id),
      anchoredCount: assigned.size,
    },
  };
}
