import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  downloadBlob,
  downloadBlobIfChanged,
  statusCodeOf,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';

import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import { env } from '@/config/environment';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const PREFIX = 'system/permission-cache/v1';
const MAX_USERS = 2000;
const MAX_SNAPSHOTS = 32;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const snapshotSchema = z.object({
  globalGeneration: z.string(),
  checkedAt: z.number().finite().nonnegative(),
  expiresAt: z.number().finite().nonnegative(),
  value: z.unknown(),
});
const userSchema = z.object({
  version: z.literal(1),
  tenantId: z.string(),
  userId: z.string(),
  generation: z.string(),
  snapshots: z.record(z.string(), snapshotSchema),
  invalidatedAt: z.string().optional(),
  invalidatedBy: z.string().optional(),
});
const globalSchema = z.object({
  version: z.literal(1),
  generation: z.string(),
  invalidatedAt: z.string().optional(),
  invalidatedBy: z.string().optional(),
});
type UserRecord = z.infer<typeof userSchema>;
type GlobalRecord = z.infer<typeof globalSchema>;
type Stored<T> = { value: T; etag: string | null };

/** A refresh raced an admin invalidation. Retry on a new request, never authorize it. */
export class PermissionCacheInvalidatedError extends Error {
  constructor() {
    super('Permissions changed during verification; retry the request');
    this.name = 'PermissionCacheInvalidatedError';
  }
}

export interface PermissionSnapshot<T> {
  value: T;
  checkedAt: number;
  expiresAt: number;
}

export interface PermissionCachePolicy {
  maxAgeMs: number;
  /** Local cooldown for lookup failures. Failures are never stored as verified snapshots. */
  failureTtlMs?: (error: unknown) => number;
  /**
   * True when a lookup error contains usable partial permissions. Such errors
   * must pass shared-generation/age validation before propagation, and their
   * cooldown cannot outlive the lookup's original maximum age.
   */
  failureMayAuthorize?: boolean;
}

/**
 * Shared, tenant-scoped authorization inputs with bounded memory and Blob CAS.
 * Every resolution revalidates global and user records, including memory hits.
 * No token or view-as identity is stored. Deletion is NOT invalidation: durable
 * generation tombstones fence in-flight writes and every other replica.
 */
export class PermissionCache {
  private readonly users = new Map<string, Stored<UserRecord>>();
  private readonly userBytes = new Map<string, number>();
  private memoryBytes = 0;
  private global: Stored<GlobalRecord> | undefined;
  private readonly inFlight = new Map<
    string,
    Promise<PermissionSnapshot<unknown>>
  >();
  private readonly failures = new Map<
    string,
    { error: unknown; expiresAt: number }
  >();

  /** Creates an isolated cache; storage is injected for focused replica/concurrency tests. */
  constructor(
    private readonly storage: BlobStorage,
    private readonly tenantId: string,
  ) {
    this.tenantId = tenantId.trim().toLowerCase();
    if (!this.tenantId)
      throw new Error('AZURE_TENANT_ID is required for permission caching');
  }

  private path(userId?: string): string {
    const tenant = createHash('sha256').update(this.tenantId).digest('hex');
    return userId === undefined
      ? `${PREFIX}/${tenant}/generation.json`
      : `${PREFIX}/${tenant}/users/${createHash('sha256').update(userId).digest('hex')}.json`;
  }

  private async read<T>(
    path: string,
    schema: z.ZodType<T>,
    cached?: Stored<T>,
  ): Promise<Stored<T> | null> {
    const options = {
      abortSignal: AbortSignal.timeout(5000),
      maxBytes: MAX_BYTES,
    };
    const result = cached?.etag
      ? await downloadBlobIfChanged(
          this.storage,
          path,
          cached.etag,
          'permissions.revalidate',
          options,
        )
      : await downloadBlob(this.storage, path, 'permissions.read', options);
    if (result === 'unchanged') return cached!;
    if (!result) return null;
    return {
      value: schema.parse(JSON.parse(result.buffer.toString('utf8'))),
      etag: result.etag,
    };
  }

  private async readGlobal(): Promise<Stored<GlobalRecord>> {
    const result = await this.read(this.path(), globalSchema, this.global);
    this.global = result ?? {
      value: { version: 1, generation: 'initial' },
      etag: null,
    };
    return this.global;
  }

  private async readUser(userId: string): Promise<Stored<UserRecord>> {
    const result = await this.read(
      this.path(userId),
      userSchema,
      this.users.get(userId),
    );
    const record = result ?? {
      value: {
        version: 1 as const,
        tenantId: this.tenantId,
        userId,
        generation: 'initial',
        snapshots: {},
      },
      etag: null,
    };
    if (
      record.value.userId !== userId ||
      record.value.tenantId !== this.tenantId
    ) {
      throw new Error(
        'Permission snapshot identity does not match its storage key',
      );
    }
    this.remember(userId, record);
    return record;
  }

  private remember(userId: string, record: Stored<UserRecord>): void {
    this.forget(userId);
    const bytes = Buffer.byteLength(JSON.stringify(record.value));
    while (
      this.users.size >= MAX_USERS ||
      this.memoryBytes + bytes > MAX_MEMORY_BYTES
    ) {
      const oldest = this.users.keys().next().value;
      if (oldest === undefined) return;
      this.forget(oldest);
    }
    this.users.set(userId, record);
    this.userBytes.set(userId, bytes);
    this.memoryBytes += bytes;
  }

  private forget(userId: string): void {
    this.memoryBytes -= this.userBytes.get(userId) ?? 0;
    this.userBytes.delete(userId);
    this.users.delete(userId);
  }

  /**
   * Resolves one validated input, checking shared generations on every call.
   * userId is the authenticated immutable object ID; key includes resource revisions.
   * loader must verify the requesting user's authority. Throws on storage/lookup
   * failure or concurrent invalidation. Expiry is anchored to lookup START, not
   * a later replica read. Concurrent calls in the same generation share work.
   */
  async resolve<T>(
    userId: string,
    key: string,
    schema: z.ZodType<T>,
    loader: () => Promise<T>,
    policy: PermissionCachePolicy,
  ): Promise<PermissionSnapshot<T>> {
    userId = userId.trim().toLowerCase();
    if (
      !userId ||
      !key ||
      !Number.isFinite(policy.maxAgeMs) ||
      policy.maxAgeMs <= 0
    ) {
      throw new Error(
        'Permission cache requires a user, resource key and positive maximum age',
      );
    }
    const [global, user] = await Promise.all([
      this.readGlobal(),
      this.readUser(userId),
    ]);
    const generation = global.value.generation;
    const now = Date.now();
    const cached = user.value.snapshots[key];
    if (
      cached &&
      cached.globalGeneration === generation &&
      cached.checkedAt <= now &&
      now < Math.min(cached.expiresAt, cached.checkedAt + policy.maxAgeMs)
    ) {
      return { ...cached, value: schema.parse(cached.value) };
    }
    const workKey = JSON.stringify([
      userId,
      key,
      generation,
      user.value.generation,
      policy.maxAgeMs,
      policy.failureMayAuthorize === true,
    ]);
    const failure = this.failures.get(workKey);
    if (failure && now < failure.expiresAt) throw failure.error;
    this.failures.delete(workKey);
    const running = this.inFlight.get(workKey);
    if (running) return running as Promise<PermissionSnapshot<T>>;
    const checkedAt = Date.now();
    const work = this.refresh(
      userId,
      key,
      schema,
      loader,
      policy,
      global,
      user,
      checkedAt,
    )
      .catch((error: unknown) => {
        if (!(error instanceof PermissionCacheInvalidatedError)) {
          const ttl = policy.failureTtlMs?.(error) ?? 0;
          if (ttl > 0) {
            if (this.failures.size >= MAX_USERS)
              this.failures.delete(this.failures.keys().next().value!);
            const expiresAt = policy.failureMayAuthorize
              ? Math.min(Date.now() + ttl, checkedAt + policy.maxAgeMs)
              : Date.now() + ttl;
            if (expiresAt > Date.now())
              this.failures.set(workKey, { error, expiresAt });
          }
        }
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(workKey);
      });
    this.inFlight.set(workKey, work);
    return work;
  }

  private async refresh<T>(
    userId: string,
    key: string,
    schema: z.ZodType<T>,
    loader: () => Promise<T>,
    policy: PermissionCachePolicy,
    global: Stored<GlobalRecord>,
    initial: Stored<UserRecord>,
    checkedAt: number,
  ): Promise<PermissionSnapshot<T>> {
    let value: T;
    try {
      value = schema.parse(await loader());
    } catch (error) {
      if (policy.failureMayAuthorize) {
        // A partial result carried by an error is still authorization data.
        // It must not escape via the exception path before these checks.
        await this.assertGeneration(userId, global, initial);
        if (Date.now() >= checkedAt + policy.maxAgeMs) {
          throw new Error(
            'Partial permission snapshot expired during verification',
          );
        }
      }
      throw error;
    }
    const snapshot = {
      globalGeneration: global.value.generation,
      checkedAt,
      expiresAt: checkedAt + policy.maxAgeMs,
      value,
    };
    // CAS merges independent resource refreshes without resurrecting invalidated data.
    for (let attempt = 0; attempt < 4; attempt++) {
      const [currentGlobal, current] = await Promise.all([
        this.readGlobal(),
        this.readUser(userId),
      ]);
      if (
        currentGlobal.value.generation !== global.value.generation ||
        current.value.generation !== initial.value.generation
      ) {
        throw new PermissionCacheInvalidatedError();
      }
      if (Date.now() >= snapshot.expiresAt)
        throw new Error('Permission verification exceeded its maximum age');
      const newer = current.value.snapshots[key];
      const selected =
        newer &&
        newer.globalGeneration === snapshot.globalGeneration &&
        newer.checkedAt >= checkedAt &&
        newer.checkedAt <= Date.now() &&
        Date.now() <
          Math.min(newer.expiresAt, newer.checkedAt + policy.maxAgeMs)
          ? { ...newer, value: schema.parse(newer.value) }
          : snapshot;
      const entries = Object.entries(current.value.snapshots)
        .filter(
          ([name, entry]) =>
            name !== key &&
            entry.globalGeneration === snapshot.globalGeneration &&
            entry.expiresAt > Date.now(),
        )
        .sort((a, b) => b[1].checkedAt - a[1].checkedAt)
        .slice(0, MAX_SNAPSHOTS - 1);
      const record: UserRecord = {
        ...current.value,
        snapshots: { ...Object.fromEntries(entries), [key]: selected },
      };
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES)
        throw new Error('Permission snapshot exceeds the storage size limit');
      try {
        const etag = await uploadJson(
          this.storage,
          this.path(userId),
          record,
          current.etag,
          'permissions.write',
          { abortSignal: AbortSignal.timeout(5000) },
        );
        this.remember(userId, { value: record, etag });
        // Global invalidation and user CAS live in separate blobs. Recheck both
        // before returning; an old-generation write is never a usable snapshot.
        const [finalGlobal, finalUser] = await Promise.all([
          this.readGlobal(),
          this.readUser(userId),
        ]);
        if (
          finalGlobal.value.generation !== global.value.generation ||
          finalUser.value.generation !== initial.value.generation
        ) {
          throw new PermissionCacheInvalidatedError();
        }
        if (
          Date.now() >=
          Math.min(selected.expiresAt, selected.checkedAt + policy.maxAgeMs)
        ) {
          throw new Error('Permission snapshot expired during verification');
        }
        return { ...selected, value: schema.parse(selected.value) };
      } catch (error) {
        if (!(error instanceof AgentAccessConflictError)) throw error;
      }
    }
    throw new Error(
      'Permission snapshot changed repeatedly; retry verification',
    );
  }

  private async assertGeneration(
    userId: string,
    global: Stored<GlobalRecord>,
    user: Stored<UserRecord>,
  ): Promise<void> {
    const [currentGlobal, currentUser] = await Promise.all([
      this.readGlobal(),
      this.readUser(userId),
    ]);
    if (
      currentGlobal.value.generation !== global.value.generation ||
      currentUser.value.generation !== user.value.generation
    ) {
      throw new PermissionCacheInvalidatedError();
    }
  }

  private async invalidationEtag(userId?: string): Promise<string | null> {
    const abortSignal = AbortSignal.timeout(5000);
    try {
      // Metadata-only recovery works even for invalid JSON, a wrong identity,
      // or an oversized payload. Never trust or preserve the corrupt contents.
      const result = await withAzureRetry(
        () =>
          this.storage
            .getBlockBlobClient(this.path(userId))
            .getProperties({ abortSignal }),
        { label: 'permissions.invalidationEtag' },
      );
      if (!result.etag)
        throw new Error('Permission cache metadata is missing its CAS ETag');
      return result.etag;
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      throw error;
    }
  }

  /**
   * Durably invalidates a user or all users (userId omitted). Requires the caller
   * to authorize the admin first. Returns only after Blob confirms the CAS write;
   * throws on outage/contention. Existing authorized operations are not undone.
   */
  async invalidate(
    actor: string,
    userId?: string,
  ): Promise<{ generation: string; invalidatedAt: string }> {
    userId = userId?.trim().toLowerCase();
    if (!actor.trim() || userId === '')
      throw new Error('Invalid permission invalidation identity');
    const invalidatedAt = new Date().toISOString();
    const generation = randomUUID();
    for (let attempt = 0; attempt < 4; attempt++) {
      const etag = await this.invalidationEtag(userId);
      const value = {
        version: 1 as const,
        generation,
        invalidatedAt,
        invalidatedBy: actor,
        ...(userId === undefined
          ? {}
          : { tenantId: this.tenantId, userId, snapshots: {} }),
      };
      try {
        await uploadJson(
          this.storage,
          this.path(userId),
          value,
          etag,
          'permissions.invalidate',
          { abortSignal: AbortSignal.timeout(5000) },
        );
        if (userId === undefined) this.global = undefined;
        else this.forget(userId);
        return { generation, invalidatedAt };
      } catch (error) {
        if (!(error instanceof AgentAccessConflictError)) throw error;
      }
    }
    throw new Error('Permission cache changed repeatedly; retry invalidation');
  }

  /** Clears replica memory only, for tests. It intentionally does not invalidate shared data. */
  clearMemory(): void {
    this.users.clear();
    this.userBytes.clear();
    this.memoryBytes = 0;
    this.global = undefined;
    this.failures.clear();
  }
}

let instance: PermissionCache | undefined;

/** Returns the server's shared cache. Throws if the authenticated tenant is unconfigured. */
export function getPermissionCache(): PermissionCache {
  return (instance ??= new PermissionCache(
    createAdminBlobStorage(),
    env.AZURE_TENANT_ID ?? '',
  ));
}
