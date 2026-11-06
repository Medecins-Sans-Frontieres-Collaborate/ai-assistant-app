/** Shared, client-safe contracts for environment-local auxiliary inference. */
import type { DeployedModel } from '@/lib/services/models/ModelDiscoveryService';

import type { OpenAIModel } from '@/types/openai';

import { z } from 'zod';

export const AUXILIARY_PURPOSES = ['routing', 'searchAssessment'] as const;
export const AUXILIARY_REGIONS = ['EU', 'US'] as const;
export const AUXILIARY_BINDINGS = ['EU', 'US', 'default'] as const;
export const AUXILIARY_OPERATION_REVISION = 1;
export const AUXILIARY_LIMITS = {
  chainLength: 5,
  attempts: 3,
  routingMs: 8000,
  deliveryReserveMs: 2000,
  lowReasoningTokens: 768,
  framingTokens: 128,
  refreshMs: 5 * 60_000,
  inventoryMaxAgeMs: 60 * 60_000,
  policyMaxAgeMs: 60 * 60_000,
  cooldownMs: 60_000,
  missingCooldownMs: 5 * 60_000,
  probeFreshMs: 24 * 60 * 60_000,
  probeIntervalMs: 60_000,
} as const;
export type AuxiliaryPurpose = (typeof AUXILIARY_PURPOSES)[number];
export type AuxiliaryRegion = (typeof AUXILIARY_REGIONS)[number];
export type AuxiliaryBinding = (typeof AUXILIARY_BINDINGS)[number];
export type AuxiliaryOperation = 'skills' | 'tools' | 'trim' | 'assessment';
export const PURPOSE_OPERATIONS: Record<
  AuxiliaryPurpose,
  AuxiliaryOperation[]
> = {
  routing: ['skills', 'tools', 'trim'],
  searchAssessment: ['assessment'],
};

export const AuxiliaryReferenceSchema = z
  .object({
    accountBinding: z.enum(AUXILIARY_BINDINGS),
    deploymentName: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9._-]+$/),
  })
  .strict();
export type AuxiliaryReference = z.infer<typeof AuxiliaryReferenceSchema>;
const chainSchema = z
  .array(AuxiliaryReferenceSchema)
  .max(AUXILIARY_LIMITS.chainLength)
  .refine(
    (entries) => new Set(entries.map(referenceKey)).size === entries.length,
    'Duplicate deployment',
  );
const regionalSchema = z.object({ EU: chainSchema, US: chainSchema }).strict();
export const AuxiliaryAssignmentsSchema = z
  .object({
    routing: regionalSchema,
    searchAssessment: regionalSchema,
  })
  .strict();
export type AuxiliaryAssignments = z.infer<typeof AuxiliaryAssignmentsSchema>;
export const AuxiliaryPolicySchema = z
  .object({
    version: z.literal(1),
    environment: z.string().min(1).max(32),
    assignments: AuxiliaryAssignmentsSchema,
    updatedAt: z.string().datetime(),
    updatedBy: z.string().min(1).max(254),
  })
  .strict();
export type AuxiliaryPolicy = z.infer<typeof AuxiliaryPolicySchema>;

/** Stable server-binding/deployment identity; takes no endpoint or credential. */
export function referenceKey(reference: AuxiliaryReference): string {
  return `${reference.accountBinding}:${reference.deploymentName}`;
}

export interface AuxiliaryAccount {
  binding: AuxiliaryBinding;
  resourcePath?: string;
  endpoint?: string;
  configured: boolean;
  error?: string;
}
export interface AuxiliaryInventory {
  account: AuxiliaryAccount;
  status: 'current' | 'stale' | 'unavailable';
  fetchedAt?: string;
  location?: string;
  retirementAvailable: boolean;
  models: DeployedModel[];
  error?: string;
}
export interface AuxiliaryCandidate {
  capabilityKnown?: boolean;
  priority?: number;
  reference: AuxiliaryReference;
  deployment: DeployedModel;
  model: OpenAIModel;
  endpoint: string;
  fingerprint: string;
}
export type AuxiliaryFailure =
  | 'endpoint_missing'
  | 'deployment_missing'
  | 'unauthorized'
  | 'timeout'
  | 'throttled'
  | 'incompatible'
  | 'provider'
  | 'residency'
  | 'retired'
  | 'inventory_unavailable'
  | 'refused';
export interface AuxiliaryObservation {
  operationRevision: number;
  key: string;
  operation: AuxiliaryOperation;
  fingerprint: string;
  policyRevision: string;
  checkedAt: string;
  success: boolean;
  reason?: AuxiliaryFailure;
  httpStatus?: number;
  durationMs: number;
  source: 'runtime' | 'probe';
  fallback: boolean;
}
export interface AuxiliaryCandidateStatus {
  reference: AuxiliaryReference;
  deployment?: DeployedModel;
  eligible: boolean;
  reason?: AuxiliaryFailure;
  fingerprint?: string;
  retiringSoon: boolean;
  movingSoon: boolean;
  retirementUnknown: boolean;
  observations: AuxiliaryObservation[];
}
export interface AuxiliaryChainReport {
  runtimeFallback?: boolean;
  purpose: AuxiliaryPurpose;
  region: AuxiliaryRegion;
  state:
    | 'ready'
    | 'unverified'
    | 'fallback'
    | 'unavailable'
    | 'check_unavailable';
  redundancy: number;
  candidates: AuxiliaryCandidateStatus[];
}
export interface AuxiliaryAdminReport {
  environment: string;
  policy: AuxiliaryPolicy | null;
  etag: string | null;
  configUnavailable: boolean;
  bootstrapUnavailable?: boolean;
  defaults: AuxiliaryAssignments;
  effective: AuxiliaryAssignments;
  revision: string;
  checkedAt: string;
  inventory: AuxiliaryInventory[];
  choices: Record<AuxiliaryRegion, AuxiliaryCandidateStatus[]>;
  incidents: AuxiliaryObservation[];
  observations: AuxiliaryObservation[];
  chains: AuxiliaryChainReport[];
  history: Array<{ updatedAt: string; updatedBy: string; revision: string }>;
}
