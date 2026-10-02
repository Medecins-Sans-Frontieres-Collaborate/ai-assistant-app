/**
 * Strict write schemas for the two admin-authored analytics documents.
 * Audience terms reuse the limits jurisdiction write schema, so a target is
 * canonicalized and bounded identically wherever it is authored.
 */
import {
  ANALYTICS_FIELD_IDS,
  isIdentifierColumn,
  normalizeColumnName,
} from '@/lib/services/analytics/fields';
import {
  isSafeRelativePath,
  normalizeFolderPath,
} from '@/lib/services/analytics/paths';
import {
  ANALYTICS_ACCESS_LEVELS,
  ANALYTICS_REPORT_TYPE_IDS,
  MAX_ANALYTICS_FOLDERS,
  MAX_AUDIENCE_ENTRIES,
  MAX_CLASSIFIED_COLUMNS,
  MAX_RETENTION_MONTHS,
} from '@/lib/services/analytics/types';
import { jurisdictionPredicateWriteSchema } from '@/lib/services/limits/policyWriteSchema';

import { z } from 'zod';

const fieldIdSchema = z.enum(ANALYTICS_FIELD_IDS);

const audienceEntryWriteSchema = jurisdictionPredicateWriteSchema
  .extend({ level: z.enum(ANALYTICS_ACCESS_LEVELS) })
  .strict();

export const analyticsFolderWriteSchema = z
  .object({
    path: z
      .string()
      .max(400)
      .transform(normalizeFolderPath)
      .refine(isSafeRelativePath, { message: 'Not a valid folder path' }),
    name: z
      .string()
      .max(120)
      .default('')
      .transform((name) => name.trim()),
    description: z
      .string()
      .max(500)
      .default('')
      .transform((description) => description.trim()),
    reportType: z.enum(ANALYTICS_REPORT_TYPE_IDS).nullable().default(null),
    audience: z
      .array(audienceEntryWriteSchema)
      .max(MAX_AUDIENCE_ENTRIES)
      .default([]),
    restricted: z.boolean().default(false),
    retentionMonths: z
      .number()
      .int()
      .min(1)
      .max(MAX_RETENTION_MONTHS)
      .nullable()
      .default(null),
    hiddenFields: z
      .array(fieldIdSchema)
      .max(ANALYTICS_FIELD_IDS.length)
      .default([])
      .transform((fields) => [...new Set(fields)]),
  })
  .strict();
export type WriteAnalyticsFolder = z.infer<typeof analyticsFolderWriteSchema>;

export const analyticsFoldersPutBodySchema = z
  .object({
    folders: z.array(analyticsFolderWriteSchema).max(MAX_ANALYTICS_FOLDERS),
  })
  .strict();

export const analyticsFieldPolicyPutBodySchema = z
  .object({
    hidden: z
      .array(fieldIdSchema)
      .max(ANALYTICS_FIELD_IDS.length)
      .default([])
      .transform((fields) => [...new Set(fields)]),
    /** Column name → the field an admin filed it under. */
    columns: z
      .record(z.string().min(1).max(200), fieldIdSchema)
      .default({})
      .transform((columns) =>
        Object.fromEntries(
          Object.entries(columns).map(([column, field]) => [
            normalizeColumnName(column),
            field,
          ]),
        ),
      )
      .refine(
        (columns) => Object.keys(columns).length <= MAX_CLASSIFIED_COLUMNS,
        { message: 'Too many classified columns' },
      )
      // A direct identifier is never a field the policy can show.
      .refine(
        (columns) =>
          !Object.keys(columns).some((column) => isIdentifierColumn(column)),
        { message: 'An identifier column cannot be classified as a field' },
      ),
  })
  .strict();
export type WriteAnalyticsFieldPolicy = z.infer<
  typeof analyticsFieldPolicyPutBodySchema
>;
