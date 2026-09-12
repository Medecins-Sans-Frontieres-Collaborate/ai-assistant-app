import {
  FORM_LIMITS,
  FieldProvenance,
  FieldValue,
  FillConfidence,
  FormField,
  QuestionMode,
} from '@/types/formFill';

import { isEmptyValue } from './validation';

/**
 * Strict json_schema for a fill run, built per request from the TARGET
 * field list (the `columnsToRowSchema` idea from the data workflow). Every
 * target field is a required property whose value may be null; strict mode
 * forbids omitted keys, so "not found" is an explicit null with gaps.
 */

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function assertSafeFieldId(id: string): void {
  if (RESERVED_KEYS.has(id) || !FORM_LIMITS.FIELD_ID_PATTERN.test(id)) {
    throw new Error('Invalid field id');
  }
}

function valueSchema(field: FormField): Record<string, unknown> {
  switch (field.type) {
    case 'number':
      return { type: ['number', 'null'] };
    case 'boolean':
      return { type: ['boolean', 'null'] };
    case 'list<number>':
      return { type: ['array', 'null'], items: { type: 'number' } };
    case 'list<text>':
    case 'list<longtext>':
      return { type: ['array', 'null'], items: { type: 'string' } };
    case 'enum': {
      const values = field.validation?.enumValues ?? [];
      return values.length > 0
        ? { type: ['string', 'null'], enum: [...values, null] }
        : { type: ['string', 'null'] };
    }
    case 'date':
      return {
        type: ['string', 'null'],
        description: 'ISO 8601 date (YYYY-MM-DD)',
      };
    default:
      return { type: ['string', 'null'] };
  }
}

function proposalSchema(field: FormField): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      value: {
        ...valueSchema(field),
        description: `${field.label}${field.description ? ` — ${field.description}` : ''}. null when the material does not support a value.`,
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      gaps: {
        type: 'string',
        description:
          'What is still missing or uncertain for this field, in the document language; empty string when the value is complete.',
      },
      generalKnowledge: {
        type: 'boolean',
        description:
          'true ONLY when the value is common knowledge needing no source (e.g. a capital city) — never for facts about the subject.',
      },
      provenance: {
        type: 'array',
        description:
          'Verbatim excerpts (≤ 300 chars each, in the source language) that support the value, with the source id they came from. Empty when value is null or generalKnowledge.',
        items: {
          type: 'object',
          properties: {
            sourceId: { type: 'string' },
            excerpt: { type: 'string' },
          },
          required: ['sourceId', 'excerpt'],
          additionalProperties: false,
        },
      },
    },
    required: ['value', 'confidence', 'gaps', 'generalKnowledge', 'provenance'],
    additionalProperties: false,
  };
}

export function buildFillSchema(
  targets: FormField[],
  mode: QuestionMode,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of targets) {
    assertSafeFieldId(field.id);
    properties[field.id] = proposalSchema(field);
  }
  return {
    type: 'object',
    properties: {
      fields: {
        type: 'object',
        properties,
        required: targets.map((f) => f.id),
        additionalProperties: false,
      },
      questions: {
        type: 'array',
        description:
          mode === 'general'
            ? 'Up to 3 open questions about the subject as a whole that would unblock the most fields; fieldIds lists the fields each would help.'
            : 'Up to 3 targeted questions, each naming the specific fields still empty or partial that the answer would fill.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            fieldIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'fieldIds'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields', 'questions'],
    additionalProperties: false,
  };
}

/* ------------------------------------------------------------------ */
/* Response normalization                                              */
/* ------------------------------------------------------------------ */

export interface RawFillProposal {
  value: unknown;
  confidence: string;
  gaps: string;
  generalKnowledge: boolean;
  provenance: Array<{ sourceId: string; excerpt: string }>;
}

export interface RawFillResponse {
  fields: Record<string, RawFillProposal>;
  questions: Array<{ text: string; fieldIds: string[] }>;
}

export interface NormalizedProposal {
  fieldId: string;
  value: FieldValue;
  confidence: FillConfidence;
  gaps?: string;
  generalKnowledge?: boolean;
  provenance: FieldProvenance[];
}

const MAX_EXCERPT_CHARS = 300;

function coerceValue(field: FormField, raw: unknown): FieldValue {
  if (raw === null || raw === undefined) return null;
  switch (field.type) {
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null;
    case 'list<number>':
      return Array.isArray(raw)
        ? raw
            .filter((v): v is number => typeof v === 'number')
            .slice(0, FORM_LIMITS.MAX_LIST_ITEMS)
            .map(String)
        : null;
    case 'list<text>':
    case 'list<longtext>':
      return Array.isArray(raw)
        ? raw
            .map((v) => String(v ?? '').trim())
            .filter((v) => v !== '')
            .slice(0, FORM_LIMITS.MAX_LIST_ITEMS)
            .map((v) => v.slice(0, FORM_LIMITS.MAX_VALUE_CHARS))
        : null;
    default: {
      const text = typeof raw === 'string' ? raw : String(raw);
      const trimmed = text.trim();
      return trimmed === ''
        ? null
        : trimmed.slice(0, FORM_LIMITS.MAX_VALUE_CHARS);
    }
  }
}

/**
 * Turns the model's response into proposals the client can queue. Drops
 * proposals for unknown fields, null values without gaps (nothing to
 * review), and excerpts that cite unknown sources (a fabricated citation is
 * worse than none — the value then reads as unsourced, i.e. partial).
 */
export function normalizeFillResponse(
  raw: RawFillResponse,
  targets: FormField[],
  knownSourceIds: ReadonlySet<string>,
): {
  proposals: NormalizedProposal[];
  questions: Array<{ text: string; fieldIds: string[] }>;
} {
  const byId = new Map(targets.map((f) => [f.id, f]));
  const proposals: NormalizedProposal[] = [];
  for (const [fieldId, proposal] of Object.entries(raw.fields ?? {})) {
    const field = byId.get(fieldId);
    if (!field || !proposal || typeof proposal !== 'object') continue;
    const value = coerceValue(field, proposal.value);
    const gaps =
      typeof proposal.gaps === 'string' && proposal.gaps.trim() !== ''
        ? proposal.gaps.trim().slice(0, 1_000)
        : undefined;
    if (isEmptyValue(value) && !gaps) continue;
    const provenance = (
      Array.isArray(proposal.provenance) ? proposal.provenance : []
    )
      .filter(
        (p) =>
          p &&
          typeof p.sourceId === 'string' &&
          knownSourceIds.has(p.sourceId) &&
          typeof p.excerpt === 'string' &&
          p.excerpt.trim() !== '',
      )
      .slice(0, 5)
      .map((p) => ({
        sourceId: p.sourceId,
        excerpt: p.excerpt.trim().slice(0, MAX_EXCERPT_CHARS),
      }));
    const confidence: FillConfidence =
      proposal.confidence === 'high' ||
      proposal.confidence === 'medium' ||
      proposal.confidence === 'low'
        ? proposal.confidence
        : 'low';
    proposals.push({
      fieldId,
      value,
      confidence,
      gaps,
      generalKnowledge: proposal.generalKnowledge === true || undefined,
      provenance,
    });
  }
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .filter((q) => q && typeof q.text === 'string' && q.text.trim() !== '')
    .slice(0, FORM_LIMITS.MAX_QUESTIONS_PER_ROUND)
    .map((q) => ({
      text: q.text.trim().slice(0, 600),
      fieldIds: (Array.isArray(q.fieldIds) ? q.fieldIds : []).filter(
        (id): id is string => typeof id === 'string' && byId.has(id),
      ),
    }));
  return { proposals, questions };
}

/* ------------------------------------------------------------------ */
/* Validate pass                                                       */
/* ------------------------------------------------------------------ */

export function buildValidateSchema(
  fieldIds: string[],
  ruleCount: number,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const id of fieldIds) {
    assertSafeFieldId(id);
    properties[id] = {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['ok', 'note'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: {
      fields: {
        type: 'object',
        properties,
        required: fieldIds,
        additionalProperties: false,
      },
      rules: {
        type: 'array',
        description: `Exactly ${ruleCount} verdicts, in the order the rules were given`,
        items: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields', 'rules'],
    additionalProperties: false,
  };
}

export interface RawValidateResponse {
  fields: Record<string, { ok: boolean; note: string }>;
  rules: Array<{ ok: boolean; note: string }>;
}
