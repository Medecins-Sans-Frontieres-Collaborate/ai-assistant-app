/**
 * Strict write schema for the shared delegations document. Reuses the limits
 * jurisdiction write schema so a jurisdiction is canonicalized and bounded
 * identically wherever it is authored.
 */
import {
  DEFAULT_MAX_OVERRIDES,
  DelegationGrantSchema,
  MAX_DELEGATION_ADMINS,
  MAX_SHARED_DELEGATIONS,
} from '@/lib/services/delegations/types';
import {
  MAX_JURISDICTION_PREDICATES,
  jurisdictionPredicateWriteSchema,
} from '@/lib/services/limits/policyWriteSchema';
import { DELEGATION_ID_RE } from '@/lib/services/limits/types';

import { z } from 'zod';

const adminWriteSchema = z
  .object({
    mail: z
      .string()
      .min(3)
      .max(320)
      .transform((mail) => mail.trim().toLowerCase()),
    grants: z.union([
      z.literal('all'),
      z
        .array(DelegationGrantSchema)
        .max(10)
        .transform((grants) => [...new Set(grants)]),
    ]),
  })
  .strict();

export const sharedDelegationWriteSchema = z
  .object({
    /** Absent → the server generates one. */
    id: z.string().regex(DELEGATION_ID_RE).optional(),
    label: z.string().max(200).default(''),
    enabled: z.boolean().default(true),
    jurisdiction: z
      .array(jurisdictionPredicateWriteSchema)
      .max(MAX_JURISDICTION_PREDICATES)
      .default([]),
    capabilities: z
      .array(DelegationGrantSchema)
      .max(10)
      .default([])
      .transform((capabilities) => [...new Set(capabilities)]),
    admins: z.array(adminWriteSchema).max(MAX_DELEGATION_ADMINS).default([]),
    limits: z
      .object({
        maxOverrides: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(DEFAULT_MAX_OVERRIDES),
      })
      .strict()
      .default({ maxOverrides: DEFAULT_MAX_OVERRIDES }),
  })
  .strict();
export type WriteSharedDelegation = z.infer<typeof sharedDelegationWriteSchema>;

export const delegationsPutBodySchema = z
  .object({
    delegations: z
      .array(sharedDelegationWriteSchema)
      .max(MAX_SHARED_DELEGATIONS),
  })
  .strict();
