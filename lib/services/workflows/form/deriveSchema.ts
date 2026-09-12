import {
  FORM_FIELD_TYPES,
  FORM_LIMITS,
  FieldValidation,
  FormField,
  FormFieldType,
  FormSection,
  FormTemplate,
} from '@/types/formFill';

/**
 * Strict json_schema for the derive call (fields + sections + validation +
 * language) and the normalization that turns the model's proposal into a
 * template draft: slug ids, de-duplication, section repair, caps. The
 * model never chooses ids the client must trust — ids are minted here.
 */

export const DERIVE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short name for the form/document' },
    description: { type: 'string' },
    language: {
      type: 'string',
      description:
        'Language the form is written in (English name, e.g. "French"); empty when unclear',
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Short stable key (lowercase letters/underscores)',
          },
          heading: { type: 'string' },
          guidance: {
            type: 'string',
            description:
              'Instructions the form gives for this section; empty when none',
          },
        },
        required: ['key', 'heading', 'guidance'],
        additionalProperties: false,
      },
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Short stable key (lowercase letters/underscores)',
          },
          sectionKey: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string', enum: [...FORM_FIELD_TYPES] },
          description: {
            type: 'string',
            description:
              'What the form asks for here, including any guidance text next to the field; empty when none',
          },
          required: { type: 'boolean' },
          enumValues: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Allowed options for enum fields (checkbox/radio/select lists); empty otherwise',
          },
          minWords: { type: ['integer', 'null'] },
          maxWords: { type: ['integer', 'null'] },
          maxChars: { type: ['integer', 'null'] },
          minItems: { type: ['integer', 'null'] },
          rubric: {
            type: 'string',
            description:
              'A semantic requirement a reviewer would check for narrative fields (e.g. "must state a baseline and a target"); empty when none',
          },
          example: {
            type: 'string',
            description:
              'A sample answer if the form gives one; empty otherwise',
          },
        },
        required: [
          'key',
          'sectionKey',
          'label',
          'type',
          'description',
          'required',
          'enumValues',
          'minWords',
          'maxWords',
          'maxChars',
          'minItems',
          'rubric',
          'example',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'description', 'language', 'sections', 'fields'],
  additionalProperties: false,
} as const;

export interface RawDerivedSection {
  key: string;
  heading: string;
  guidance: string;
}

export interface RawDerivedField {
  key: string;
  sectionKey: string;
  label: string;
  type: string;
  description: string;
  required: boolean;
  enumValues: string[];
  minWords: number | null;
  maxWords: number | null;
  maxChars: number | null;
  minItems: number | null;
  rubric: string;
  example: string;
}

export interface RawDerivedTemplate {
  name: string;
  description: string;
  language: string;
  sections: RawDerivedSection[];
  fields: RawDerivedField[];
}

/** Lowercase ascii slug that satisfies FIELD_ID_PATTERN. */
export function slugify(text: string, fallback: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '')
    .slice(0, 40);
  return slug || fallback;
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    const suffix = `_${n}`;
    id = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    n += 1;
  }
  taken.add(id);
  return id;
}

function isFieldType(value: string): value is FormFieldType {
  return (FORM_FIELD_TYPES as readonly string[]).includes(value);
}

function positiveInt(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export interface DerivedDraft {
  name: string;
  description?: string;
  language?: string;
  sections: FormSection[];
  fields: FormField[];
}

/**
 * Normalizes a derive response. Every field lands in a real section (an
 * "Other" section is minted for orphans), ids are unique slugs, types
 * unknown to the app degrade to text, and the caps are enforced.
 */
export function normalizeDerived(raw: RawDerivedTemplate): DerivedDraft {
  const sectionIds = new Set<string>();
  const sectionByKey = new Map<string, string>();
  const sections: FormSection[] = [];
  for (const section of (raw.sections ?? []).slice(
    0,
    FORM_LIMITS.MAX_SECTIONS,
  )) {
    const heading = String(section?.heading ?? '').trim();
    if (!heading) continue;
    const id = uniqueId(slugify(section.key || heading, 'section'), sectionIds);
    sectionByKey.set(String(section.key ?? ''), id);
    sections.push({
      id,
      heading: heading.slice(0, 300),
      guidance: section.guidance?.trim()
        ? section.guidance.trim().slice(0, 4_000)
        : undefined,
    });
  }
  let otherId: string | undefined;
  const ensureOther = () => {
    if (!otherId) {
      otherId = uniqueId('other', sectionIds);
      sections.push({ id: otherId, heading: 'Other' });
    }
    return otherId;
  };

  const fieldIds = new Set<string>();
  const fields: FormField[] = [];
  for (const field of (raw.fields ?? []).slice(0, FORM_LIMITS.MAX_FIELDS)) {
    const label = String(field?.label ?? '').trim();
    if (!label) continue;
    const id = uniqueId(slugify(field.key || label, 'field'), fieldIds);
    const type: FormFieldType = isFieldType(field.type) ? field.type : 'text';
    const enumValues = (Array.isArray(field.enumValues) ? field.enumValues : [])
      .map((v) => String(v).trim())
      .filter((v) => v !== '')
      .slice(0, 100);
    const validation: FieldValidation = {};
    if (enumValues.length > 0 && (type === 'enum' || type === 'text')) {
      validation.enumValues = enumValues;
    }
    const minWords = positiveInt(field.minWords);
    const maxWords = positiveInt(field.maxWords);
    const maxChars = positiveInt(field.maxChars);
    const minItems = positiveInt(field.minItems);
    if (minWords) validation.minWords = minWords;
    if (maxWords && (!minWords || maxWords >= minWords)) {
      validation.maxWords = maxWords;
    }
    if (maxChars) validation.maxChars = maxChars;
    if (minItems && type.startsWith('list<')) validation.minItems = minItems;
    if (field.rubric?.trim())
      validation.rubric = field.rubric.trim().slice(0, 2_000);
    const sectionId =
      sectionByKey.get(String(field.sectionKey ?? '')) ?? ensureOther();
    fields.push({
      id,
      sectionId,
      label: label.slice(0, 200),
      type: enumValues.length > 0 && type === 'text' ? 'enum' : type,
      description: field.description?.trim()
        ? field.description.trim().slice(0, 2_000)
        : undefined,
      required: field.required === true,
      validation: Object.keys(validation).length > 0 ? validation : undefined,
      examples: field.example?.trim()
        ? [field.example.trim().slice(0, 1_000)]
        : undefined,
    });
  }
  // Drop sections nothing landed in — they were headings, not containers.
  const used = new Set(fields.map((f) => f.sectionId));
  const keptSections = sections.filter((s) => used.has(s.id));
  return {
    name:
      String(raw.name ?? '')
        .trim()
        .slice(0, 200) || 'Untitled form',
    description: raw.description?.trim()
      ? raw.description.trim().slice(0, 2_000)
      : undefined,
    language: raw.language?.trim()
      ? raw.language.trim().slice(0, 60)
      : undefined,
    sections: keptSections.length > 0 ? keptSections : sections,
    fields,
  };
}

/**
 * Layout generated from structure alone (hand-authored templates, pasted
 * web forms, and the fallback when the layout call fails): a heading per
 * section, a labelled slot per field.
 */
export function layoutFromStructure(draft: {
  name: string;
  sections: FormSection[];
  fields: FormField[];
}): string {
  const lines: string[] = [`# ${draft.name}`, ''];
  for (const section of draft.sections) {
    const fields = draft.fields.filter((f) => f.sectionId === section.id);
    if (fields.length === 0) continue;
    lines.push(`## ${section.heading}`, '');
    if (section.guidance) lines.push(`_${section.guidance}_`, '');
    for (const field of fields) {
      if (field.type === 'longtext' || field.type.startsWith('list<')) {
        lines.push(`### ${field.label}`, '', `{{field:${field.id}}}`, '');
      } else {
        lines.push(`**${field.label}:** {{field:${field.id}}}`, '');
      }
    }
  }
  return lines.join('\n').trim() + '\n';
}

/** Slot ids referenced by a layout, in order of first appearance. */
export function layoutSlotIds(layout: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of layout.matchAll(
    /\{\{field:([a-z][a-z0-9_]{0,39})\}\}/g,
  )) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      ids.push(match[1]);
    }
  }
  return ids;
}

/**
 * A model-written layout is accepted only when it places every field
 * exactly by id and invents none; otherwise the structural layout is used.
 * Missing slots are appended under their section rather than lost.
 */
export function reconcileLayout(
  layout: string,
  draft: { name: string; sections: FormSection[]; fields: FormField[] },
): string {
  const known = new Set(draft.fields.map((f) => f.id));
  const present = layoutSlotIds(layout);
  if (present.some((id) => !known.has(id))) {
    return layoutFromStructure(draft);
  }
  const missing = draft.fields.filter((f) => !present.includes(f.id));
  if (missing.length === 0) return layout.trim() + '\n';
  if (missing.length > draft.fields.length / 2) {
    return layoutFromStructure(draft);
  }
  const appendix = layoutFromStructure({
    name: draft.name,
    sections: draft.sections,
    fields: missing,
  })
    .split('\n')
    .slice(2) // drop the title line + blank
    .join('\n');
  return `${layout.trim()}\n\n${appendix}`.trim() + '\n';
}

export function buildTemplateDraft(
  draft: DerivedDraft,
  options: { layout?: string; original?: FormTemplate['original'] },
): Omit<FormTemplate, 'id' | 'origin' | 'createdAt' | 'updatedAt'> {
  return {
    name: draft.name,
    description: draft.description,
    language: draft.language,
    sections: draft.sections,
    fields: draft.fields,
    layout: options.layout
      ? reconcileLayout(options.layout, draft).slice(
          0,
          FORM_LIMITS.MAX_LAYOUT_CHARS,
        )
      : layoutFromStructure(draft),
    original: options.original,
  };
}
