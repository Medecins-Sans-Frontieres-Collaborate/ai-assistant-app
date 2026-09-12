import { FORM_FIELD_TYPES, FORM_LIMITS, FormTemplate } from '@/types/formFill';

import { compilePattern, isCalendarDate } from './validation';

import { z } from 'zod';

/**
 * Request-side validation of a template snapshot. The workflow servers are
 * stateless, so a template arrives inline with every request and is
 * re-validated every time — the same posture as document specs. Strict on
 * shape, generous on optional content.
 */

const fieldIdSchema = z
  .string()
  .regex(FORM_LIMITS.FIELD_ID_PATTERN)
  .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id));

export const FieldValidationSchema = z
  .object({
    minChars: z.number().int().min(0).max(100_000).optional(),
    maxChars: z.number().int().min(1).max(100_000).optional(),
    minWords: z.number().int().min(0).max(50_000).optional(),
    maxWords: z.number().int().min(1).max(50_000).optional(),
    pattern: z
      .string()
      .max(500)
      .refine((p) => compilePattern(p) !== null, {
        message: 'pattern must be a valid, non-backtracking regular expression',
      })
      .optional(),
    enumValues: z.array(z.string().max(200)).max(100).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    dateAfter: z.string().refine(isCalendarDate, 'YYYY-MM-DD').optional(),
    dateBefore: z.string().refine(isCalendarDate, 'YYYY-MM-DD').optional(),
    minItems: z
      .number()
      .int()
      .min(0)
      .max(FORM_LIMITS.MAX_LIST_ITEMS)
      .optional(),
    rubric: z.string().max(2_000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.minChars === undefined ||
        v.maxChars === undefined ||
        v.minChars <= v.maxChars) &&
      (v.minWords === undefined ||
        v.maxWords === undefined ||
        v.minWords <= v.maxWords) &&
      (v.min === undefined || v.max === undefined || v.min <= v.max) &&
      (v.dateAfter === undefined ||
        v.dateBefore === undefined ||
        v.dateAfter <= v.dateBefore),
    { message: 'minimum exceeds maximum' },
  );

export const FieldAnchorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('docx-control'),
    tag: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('docx-text'),
    labelText: z.string().min(1).max(200),
    occurrence: z.number().int().min(0).max(999),
    placement: z.enum([
      'after-label',
      'table-cell-right',
      'table-cell-below',
      'next-paragraph',
    ]),
  }),
  z.object({
    kind: z.literal('pdf-field'),
    fieldName: z.string().min(1).max(500),
  }),
]);

export const FormFieldSchema = z
  .object({
    id: fieldIdSchema,
    sectionId: z.string().min(1).max(80),
    label: z.string().min(1).max(200),
    type: z.enum(FORM_FIELD_TYPES as [string, ...string[]]),
    description: z.string().max(2_000).optional(),
    required: z.boolean(),
    validation: FieldValidationSchema.optional(),
    examples: z.array(z.string().max(1_000)).max(5).optional(),
    anchor: FieldAnchorSchema.optional(),
    admin: z
      .object({
        locked: z.boolean().optional(),
        prefill: z
          .discriminatedUnion('kind', [
            z.object({
              kind: z.literal('constant'),
              value: z.string().max(4_000),
            }),
            z.object({
              kind: z.literal('user'),
              attribute: z.enum([
                'displayName',
                'email',
                'department',
                'jobTitle',
                'officeLocation',
              ]),
            }),
          ])
          .optional(),
      })
      .optional(),
  })
  .strict();

export const FormSectionSchema = z
  .object({
    id: z.string().min(1).max(80),
    heading: z.string().min(1).max(300),
    guidance: z.string().max(4_000).optional(),
  })
  .strict();

/** The template envelope, before strictness and cross-field checks. */
export const FormTemplateObjectSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  language: z.string().max(60).optional(),
  sections: z.array(FormSectionSchema).min(1).max(FORM_LIMITS.MAX_SECTIONS),
  fields: z.array(FormFieldSchema).min(1).max(FORM_LIMITS.MAX_FIELDS),
  layout: z.string().max(FORM_LIMITS.MAX_LAYOUT_CHARS),
  original: z
    .object({
      fileId: z.string().min(1).max(300),
      name: z.string().min(1).max(300),
      mime: z.enum(['docx', 'pdf']),
      fillMode: z.enum([
        'docx-controls',
        'docx-anchored',
        'pdf-acroform',
        'none',
      ]),
    })
    .optional(),
  rules: z.array(z.string().max(1_000)).max(FORM_LIMITS.MAX_RULES).optional(),
  origin: z.enum(['user', 'admin']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Cross-field checks shared by user and admin bodies. */
export const refineTemplate = (
  template: {
    sections: Array<{ id: string }>;
    fields: Array<{ id: string; sectionId: string }>;
  },
  ctx: z.RefinementCtx,
) => {
  const sectionIds = new Set<string>();
  template.sections.forEach((section, index) => {
    if (sectionIds.has(section.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections', index, 'id'],
        message: 'Duplicate section id',
      });
    }
    sectionIds.add(section.id);
  });
  const seen = new Set<string>();
  template.fields.forEach((field, index) => {
    if (seen.has(field.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', index, 'id'],
        message: 'Duplicate field id',
      });
    }
    seen.add(field.id);
    if (!sectionIds.has(field.sectionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', index, 'sectionId'],
        message: 'Unknown section',
      });
    }
  });
};

export const FormTemplateSchema =
  FormTemplateObjectSchema.strict().superRefine(refineTemplate);

/**
 * What an admin sends to create/update an admin template: the template
 * without the fields the server owns (id, origin, timestamps).
 */
export const AdminTemplateBodySchema = FormTemplateObjectSchema.omit({
  id: true,
  origin: true,
  createdAt: true,
  updatedAt: true,
})
  .strict()
  .superRefine(refineTemplate);

export type AdminTemplateBody = z.infer<typeof AdminTemplateBodySchema>;

export function parseAdminTemplateBody(
  value: unknown,
): { ok: true; body: AdminTemplateBody } | { ok: false; error: string } {
  const parsed = AdminTemplateBodySchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first
        ? `${first.path.join('.') || 'template'}: ${first.message}`
        : 'Invalid template',
    };
  }
  return { ok: true, body: parsed.data };
}

export function parseTemplate(
  value: unknown,
): { ok: true; template: FormTemplate } | { ok: false; error: string } {
  const parsed = FormTemplateSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first
        ? `${first.path.join('.') || 'template'}: ${first.message}`
        : 'Invalid template',
    };
  }
  return { ok: true, template: parsed.data as FormTemplate };
}
