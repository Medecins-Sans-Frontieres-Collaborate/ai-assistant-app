/**
 * The seam between the limits policy and the shared delegations document
 * (lib/services/limits/limitsStore.ts): composition on read, the one-time
 * migration out of the policy, and the failure posture.
 *
 * Storage is faked at the blobCas level so the REAL read/migrate/strip code
 * runs against an in-memory blob map with real create-only semantics.
 */
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import { DELEGATIONS_DOCUMENT_PATH } from '@/lib/services/delegations/types';
import {
  PolicyUnreadableError,
  loadDelegationsDocument,
  readPolicy,
  writePolicy,
} from '@/lib/services/limits/limitsStore';
import {
  LIMITS_POLICY_PATH,
  LimitsPolicy,
  LimitsPolicySchema,
} from '@/lib/services/limits/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: () => ({}),
}));
vi.mock('@/lib/services/agentAccess/blobCas', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/agentAccess/blobCas')>();
  return { ...actual, downloadBlob: vi.fn(), uploadJson: vi.fn() };
});

const storage = {} as BlobStorage;
const STAMP = {
  createdBy: 'g@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'g@example.com',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const DEL = 'del-0000000000aa';

function legacyPolicy(): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults: [{ limitKey: 'chat.messagesPerDay', value: 100 }],
    overrides: [],
    delegations: [
      {
        id: DEL,
        label: 'OCP',
        enabled: true,
        admins: ['ocp-admin@ocp.msf.org'],
        jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
        maxOverrides: 40,
        ...STAMP,
      },
    ],
    updatedBy: 'g@example.com',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

/** In-memory blobs with real CAS semantics. */
let blobs: Map<string, { text: string; etag: string }>;
let etagCounter: number;

function seed(path: string, body: unknown) {
  blobs.set(path, {
    text: typeof body === 'string' ? body : JSON.stringify(body),
    etag: `"e${++etagCounter}"`,
  });
}
function stored<T>(path: string): T {
  return JSON.parse(blobs.get(path)!.text) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  blobs = new Map();
  etagCounter = 0;
  vi.mocked(downloadBlob).mockImplementation(async (_storage, path) => {
    const blob = blobs.get(path);
    return blob
      ? { buffer: Buffer.from(blob.text, 'utf8'), etag: blob.etag }
      : null;
  });
  vi.mocked(uploadJson).mockImplementation(
    async (_storage, path, payload, condition) => {
      const existing = blobs.get(path);
      if (condition === null && existing) throw new AgentAccessConflictError();
      if (typeof condition === 'string' && existing?.etag !== condition) {
        throw new AgentAccessConflictError();
      }
      seed(path, payload);
      return blobs.get(path)!.etag;
    },
  );
});

describe('one-time migration out of the limits policy', () => {
  it('creates the shared document from the legacy delegations with FULL grants, then strips the policy', async () => {
    seed(LIMITS_POLICY_PATH, legacyPolicy());

    const result = await readPolicy(storage);

    const document = stored<{
      delegations: Array<Record<string, unknown>>;
      migratedFromLimitsAt?: string;
    }>(DELEGATIONS_DOCUMENT_PATH);
    expect(document.migratedFromLimitsAt).toBeTruthy();
    expect(document.delegations[0]).toMatchObject({
      id: DEL,
      capabilities: ['limits', 'announcements'],
      admins: [{ mail: 'ocp-admin@ocp.msf.org', grants: 'all' }],
      limits: { maxOverrides: 40 },
    });
    // Abandoned in the policy…
    expect(stored<LimitsPolicy>(LIMITS_POLICY_PATH).delegations).toEqual([]);
    // …and composed back in for every limits consumer, unchanged in meaning.
    expect(result!.policy.delegations).toEqual(legacyPolicy().delegations);
  });

  it('hands back the policy ETag AFTER the strip, so the admin’s first save is not a spurious 409', async () => {
    seed(LIMITS_POLICY_PATH, legacyPolicy());
    const result = await readPolicy(storage);
    expect(result!.etag).toBe(blobs.get(LIMITS_POLICY_PATH)!.etag);
    await expect(
      writePolicy(storage, result!.policy, result!.etag),
    ).resolves.toBeTruthy();
  });

  it('is idempotent: a second read migrates nothing and composes the same delegations', async () => {
    seed(LIMITS_POLICY_PATH, legacyPolicy());
    await readPolicy(storage);
    const uploadsAfterFirst = vi.mocked(uploadJson).mock.calls.length;

    const second = await readPolicy(storage);

    expect(vi.mocked(uploadJson).mock.calls.length).toBe(uploadsAfterFirst);
    expect(second!.policy.delegations[0].id).toBe(DEL);
  });

  it('loses the create race gracefully: the winner’s document is what gets served', async () => {
    seed(LIMITS_POLICY_PATH, legacyPolicy());
    // Another replica creates the document between our read and our write.
    vi.mocked(uploadJson).mockImplementationOnce(async (_s, path) => {
      seed(path, {
        version: 1,
        delegations: [],
        migratedFromLimitsAt: 'by-the-winner',
        updatedBy: 'other-replica',
        updatedAt: 'now',
      });
      throw new AgentAccessConflictError();
    });

    const result = await loadDelegationsDocument(storage);

    expect(result.document.updatedBy).toBe('other-replica');
    // The loser never strips: the winner owns the migration.
    expect(stored<LimitsPolicy>(LIMITS_POLICY_PATH).delegations).toHaveLength(
      1,
    );
  });

  it('a failed strip is harmless: the stale copy is ignored, and the next policy write retires it', async () => {
    seed(LIMITS_POLICY_PATH, legacyPolicy());
    const realUpload = vi.mocked(uploadJson).getMockImplementation()!;
    vi.mocked(uploadJson).mockImplementation(async (s, path, payload, c, l) => {
      if (l === 'limits.stripLegacyDelegations') {
        throw new AgentAccessConflictError();
      }
      return realUpload(s, path, payload, c, l);
    });

    const result = await readPolicy(storage);
    expect(result!.policy.delegations).toHaveLength(1);
    expect(stored<LimitsPolicy>(LIMITS_POLICY_PATH).delegations).toHaveLength(
      1,
    );

    // Edit the shared document: the stale policy copy must NOT win.
    const document = stored<{ delegations: Array<{ label: string }> }>(
      DELEGATIONS_DOCUMENT_PATH,
    );
    document.delegations[0].label = 'Renamed';
    seed(DELEGATIONS_DOCUMENT_PATH, document);
    expect((await readPolicy(storage))!.policy.delegations[0].label).toBe(
      'Renamed',
    );

    // Any later policy write drops the legacy copy.
    const current = await readPolicy(storage);
    await writePolicy(storage, current!.policy, current!.etag);
    expect(stored<LimitsPolicy>(LIMITS_POLICY_PATH).delegations).toEqual([]);
  });

  it('with no policy at all, creates an EMPTY document and never creates a policy', async () => {
    const result = await loadDelegationsDocument(storage);
    expect(result.document.delegations).toEqual([]);
    expect(blobs.has(LIMITS_POLICY_PATH)).toBe(false);
    // A stored policy enforces; delegating another capability must not
    // switch limits on.
    expect(await readPolicy(storage)).toBeNull();
  });
});

describe('composition and failure posture', () => {
  it('never persists delegations with the policy again', async () => {
    seed(LIMITS_POLICY_PATH, legacyPolicy());
    const current = await readPolicy(storage);
    await writePolicy(storage, current!.policy, current!.etag);
    expect(stored<LimitsPolicy>(LIMITS_POLICY_PATH).delegations).toEqual([]);
  });

  it('projects only limits-capable delegations and limits-holding admins into the policy', async () => {
    seed(LIMITS_POLICY_PATH, { ...legacyPolicy(), delegations: [] });
    seed(DELEGATIONS_DOCUMENT_PATH, {
      version: 1,
      delegations: [
        {
          id: DEL,
          label: 'OCP',
          enabled: true,
          jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
          capabilities: ['limits', 'announcements'],
          admins: [
            { mail: 'limits@ocp.msf.org', grants: ['limits'] },
            { mail: 'sender@ocp.msf.org', grants: ['announcements'] },
          ],
          limits: { maxOverrides: 10 },
          ...STAMP,
        },
        {
          id: 'del-0000000000bb',
          label: 'Messaging only',
          enabled: true,
          jurisdiction: [{ scope: 'domain', targets: ['ocb.msf.org'] }],
          capabilities: ['announcements'],
          admins: [{ mail: 'x@ocb.msf.org', grants: 'all' }],
          ...STAMP,
        },
      ],
      updatedBy: 'g',
      updatedAt: 'now',
    });

    const result = await readPolicy(storage);

    expect(result!.policy.delegations).toHaveLength(1);
    expect(result!.policy.delegations[0]).toMatchObject({
      id: DEL,
      admins: ['limits@ocp.msf.org'],
      maxOverrides: 10,
    });
  });

  it('an UNREADABLE delegations document makes the policy unavailable (failMode) — never "no scoped overrides"', async () => {
    seed(LIMITS_POLICY_PATH, { ...legacyPolicy(), delegations: [] });
    seed(DELEGATIONS_DOCUMENT_PATH, '{not json');
    await expect(readPolicy(storage)).rejects.toBeInstanceOf(
      PolicyUnreadableError,
    );

    seed(DELEGATIONS_DOCUMENT_PATH, { version: 99 });
    await expect(readPolicy(storage)).rejects.toBeInstanceOf(
      PolicyUnreadableError,
    );
  });

  it('propagates a storage failure on the delegations read unchanged', async () => {
    seed(LIMITS_POLICY_PATH, { ...legacyPolicy(), delegations: [] });
    const outage = Object.assign(new Error('storage down'), {
      statusCode: 503,
    });
    const realDownload = vi.mocked(downloadBlob).getMockImplementation()!;
    vi.mocked(downloadBlob).mockImplementation(async (s, path, l, o) => {
      if (path === DELEGATIONS_DOCUMENT_PATH) throw outage;
      return realDownload(s, path, l, o);
    });
    await expect(readPolicy(storage)).rejects.toBe(outage);
  });
});
