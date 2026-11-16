/** Environment-partitioned auxiliary policy and bounded readiness persistence. */
import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import { auxiliaryEnvironment } from './bindings';
import {
  AUXILIARY_OPERATIONS,
  type AuxiliaryObservation,
  type AuxiliaryPolicy,
  AuxiliaryPolicySchema,
} from './types';

import { createHash } from 'crypto';
import { z } from 'zod';

const observationSchema = z.object({
  key: z.string().max(180),
  operation: z.enum(AUXILIARY_OPERATIONS),
  fingerprint: z.string().max(1024),
  operationRevision: z.number().int().nonnegative().default(0),
  policyRevision: z.string().max(200),
  checkedAt: z.string().datetime(),
  success: z.boolean(),
  reason: z
    .enum([
      'endpoint_missing',
      'deployment_missing',
      'unauthorized',
      'timeout',
      'throttled',
      'incompatible',
      'provider',
      'residency',
      'retired',
      'inventory_unavailable',
      'refused',
    ])
    .optional(),
  httpStatus: z.number().optional(),
  durationMs: z.number(),
  source: z.enum(['runtime', 'probe']),
  fallback: z.boolean(),
});
const historySchema = z.object({
  updatedAt: z.string().datetime(),
  updatedBy: z.string().max(254),
  revision: z.string().max(200),
});
const stateSchema = z.object({
  observations: z.array(observationSchema).max(200),
  history: z.array(historySchema).max(50),
  incidents: z.array(observationSchema).max(100).default([]),
});
const readBounds = (maxBytes = 1024 * 1024) => ({
  maxBytes,
  abortSignal: AbortSignal.timeout(3000),
});
export type AuxiliaryState = z.infer<typeof stateSchema>;

/** Resolve only this server environment's storage prefix, never a client-selected path. */
export function auxiliaryPrefix(): string {
  return `system/auxiliary-models/${auxiliaryEnvironment()}/`;
}

/** Read the authoritative policy and strong ETag; returns null only for a missing blob. */
export async function readAuxiliaryPolicy(
  storage: BlobStorage = createAdminBlobStorage(),
): Promise<{ policy: AuxiliaryPolicy; etag: string } | null> {
  const result = await downloadBlob(
    storage,
    `${auxiliaryPrefix()}config.json`,
    'auxiliary.readPolicy',
    readBounds(64 * 1024),
  );
  if (!result) return null;
  const policy = AuxiliaryPolicySchema.parse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (policy.environment !== auxiliaryEnvironment())
    throw new Error('Auxiliary policy environment mismatch');
  return { policy, etag: result.etag };
}

/** CAS policy write. Null ETag means create-only; conflict errors propagate to the admin API. */
export async function writeAuxiliaryPolicy(
  policy: AuxiliaryPolicy,
  etag: string | null,
  storage: BlobStorage = createAdminBlobStorage(),
): Promise<string> {
  const parsed = AuxiliaryPolicySchema.parse(policy);
  if (parsed.environment !== auxiliaryEnvironment())
    throw new Error('Auxiliary policy environment mismatch');
  return uploadJson(
    storage,
    `${auxiliaryPrefix()}config.json`,
    parsed,
    etag,
    'auxiliary.writePolicy',
    { abortSignal: AbortSignal.timeout(10_000) },
  );
}

/** Read bounded operational observations and change summaries, independently of policy. */
export async function readAuxiliaryState(
  storage: BlobStorage = createAdminBlobStorage(),
): Promise<AuxiliaryState> {
  const result = await downloadBlob(
    storage,
    `${auxiliaryPrefix()}state.json`,
    'auxiliary.readState',
    readBounds(),
  );
  return result
    ? stateSchema.parse(JSON.parse(result.buffer.toString('utf8')))
    : { observations: [], history: [], incidents: [] };
}

/** Merge newest observations with bounded CAS retries; never overwrite another replica's newer result. */
export async function persistAuxiliaryState(
  observations: AuxiliaryObservation[],
  history?: AuxiliaryState['history'][number],
  storage: BlobStorage = createAdminBlobStorage(),
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const path = `${auxiliaryPrefix()}state.json`;
    const read = await downloadBlob(
      storage,
      path,
      'auxiliary.readState',
      readBounds(),
    );
    const state = read
      ? stateSchema.parse(JSON.parse(read.buffer.toString('utf8')))
      : { observations: [], history: [], incidents: [] };
    const merged = new Map(
      state.observations.map((entry) => [
        `${entry.key}:${entry.operation}:${entry.fingerprint}:${entry.source}`,
        entry,
      ]),
    );
    const incidents = [...state.incidents];
    for (const entry of observations) {
      const key = `${entry.key}:${entry.operation}:${entry.fingerprint}:${entry.source}`;
      const previous = merged.get(key);
      const latest = [...merged.values()]
        .filter(
          (old) =>
            old.key === entry.key &&
            old.operation === entry.operation &&
            old.fingerprint === entry.fingerprint,
        )
        .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
      if (
        (!latest && !entry.success) ||
        (latest &&
          latest.checkedAt < entry.checkedAt &&
          (latest.success !== entry.success || latest.reason !== entry.reason))
      )
        incidents.push(entry);
      if (!previous || previous.checkedAt <= entry.checkedAt)
        merged.set(key, entry);
    }
    const histories = new Map(
      [...state.history, ...(history ? [history] : [])].map((entry) => [
        entry.revision,
        entry,
      ]),
    );
    const next = stateSchema.parse({
      incidents: incidents
        .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
        .slice(0, 100),
      observations: [...merged.values()]
        .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
        .slice(0, 200),
      history: [...histories.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50),
    });
    try {
      await uploadJson(
        storage,
        path,
        next,
        read?.etag ?? null,
        'auxiliary.writeState',
        { abortSignal: AbortSignal.timeout(10_000) },
      );
      return;
    } catch (error) {
      if (!(error instanceof AgentAccessConflictError) || attempt === 2)
        throw error;
    }
  }
}

/** Immutable history copy plus bounded index. Failures are visible but cannot undo a committed policy. */
export async function recordAuxiliaryHistory(
  policy: AuxiliaryPolicy,
  revision: string,
): Promise<void> {
  try {
    const storage = createAdminBlobStorage();
    await uploadJson(
      storage,
      `${auxiliaryPrefix()}history/${policy.updatedAt.replace(/[^0-9TZ]/g, '')}.json`,
      policy,
      null,
      'auxiliary.history',
      { abortSignal: AbortSignal.timeout(10_000) },
    );
    await persistAuxiliaryState(
      [],
      { updatedAt: policy.updatedAt, updatedBy: policy.updatedBy, revision },
      storage,
    );
  } catch {
    console.error('[auxiliary] Policy saved, but history persistence failed');
  }
}

/** Cross-replica bounded probe rate limit, one stable CAS record per target/purpose. */
export async function claimAuxiliaryProbe(
  key: string,
  intervalMs: number,
): Promise<boolean> {
  const storage = createAdminBlobStorage();
  const path = `${auxiliaryPrefix()}probe-claims/${createHash('sha256').update(key).digest('hex')}.json`;
  const read = await downloadBlob(
    storage,
    path,
    'auxiliary.claimProbe',
    readBounds(1024),
  );
  if (read) {
    const claim = z
      .object({ at: z.number() })
      .parse(JSON.parse(read.buffer.toString('utf8')));
    if (Date.now() - claim.at < intervalMs) return false;
  }
  try {
    await uploadJson(
      storage,
      path,
      { at: Date.now() },
      read?.etag ?? null,
      'auxiliary.claimProbe',
      { abortSignal: AbortSignal.timeout(10_000) },
    );
    return true;
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return false;
    throw error;
  }
}
