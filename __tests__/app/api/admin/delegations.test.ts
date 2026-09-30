/**
 * GET/PUT /api/admin/delegations — global admins only, CAS'd, and guarded
 * against the limits policy that references delegations by id.
 */
import { NextRequest } from 'next/server';

import { DELEGATIONS_DOCUMENT_PATH } from '@/lib/services/delegations/types';
import { LIMITS_POLICY_PATH } from '@/lib/services/limits/types';

import { parseJsonResponse } from '../helpers';
import { BlobFake, installBlobFake } from './blobFake';

import { GET, PUT } from '@/app/api/admin/delegations/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const limitsInvalidate = vi.hoisted(() => vi.fn());
const delegationsInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: () => ({}),
}));
vi.mock('@/lib/services/limits/LimitsService', () => ({
  LimitsService: { getInstance: () => ({ invalidate: limitsInvalidate }) },
}));
vi.mock('@/lib/services/delegations/DelegationsService', () => ({
  DelegationsService: {
    getInstance: () => ({ invalidate: delegationsInvalidate }),
  },
}));
vi.mock('@/lib/services/agentAccess/blobCas', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/agentAccess/blobCas')>();
  return { ...actual, downloadBlob: vi.fn(), uploadJson: vi.fn() };
});

const DEL = 'del-0000000000aa';
const STAMP = {
  createdBy: 'first@example.com',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedBy: 'first@example.com',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const storedDelegation = {
  id: DEL,
  label: 'OCP',
  enabled: true,
  jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
  capabilities: ['limits', 'announcements'],
  admins: [{ mail: 'ocp-admin@ocp.msf.org', grants: 'all' }],
  limits: { maxOverrides: 25 },
  ...STAMP,
};
const writeDelegation = {
  id: DEL,
  label: 'OCP',
  enabled: true,
  jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
  capabilities: ['limits', 'announcements'],
  admins: [{ mail: 'ocp-admin@ocp.msf.org', grants: 'all' }],
  limits: { maxOverrides: 25 },
};

let blobs: BlobFake;

function seedDocument(delegations: unknown[] = [storedDelegation]) {
  blobs.seed(DELEGATIONS_DOCUMENT_PATH, {
    version: 1,
    delegations,
    updatedBy: 'first@example.com',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
}

function seedPolicy(overrides: unknown[]) {
  blobs.seed(LIMITS_POLICY_PATH, {
    version: 1,
    defaults: [],
    overrides,
    delegations: [],
    updatedBy: 'g',
    updatedAt: 'now',
  });
}

function scopedOverride(id: string, delegationId?: string) {
  return {
    id,
    scope: 'user',
    targets: ['a@ocp.msf.org'],
    entries: [],
    ...(delegationId ? { delegationId } : {}),
    ...STAMP,
  };
}

async function put(body: unknown, etag: string | null = '"e1"') {
  return PUT(
    new NextRequest('http://localhost/api/admin/delegations', {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        ...(etag ? { 'if-match': etag } : {}),
      },
    }),
  );
}

describe('/api/admin/delegations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAuth.mockResolvedValue({
      user: { id: 'oid', mail: 'global@example.com' },
    });
    blobs = installBlobFake();
  });

  it('401s without a session and 403s anyone who is not a GLOBAL admin — including a delegate', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    mockAuth.mockResolvedValue({
      user: { id: 'oid', mail: 'ocp-admin@ocp.msf.org' },
    });
    seedDocument();
    expect((await GET()).status).toBe(403);
    expect((await put({ delegations: [] })).status).toBe(403);
  });

  it('GET returns the document and its ETag', async () => {
    seedDocument();
    const body = await parseJsonResponse(await GET());
    expect(body.data.etag).toBe('"e1"');
    expect(body.data.document.delegations[0].id).toBe(DEL);
    expect(body.data.unavailable).toBe(false);
  });

  it('GET reports unavailable on an unreadable document — NEVER an empty list the admin could save over it', async () => {
    blobs.seed(DELEGATIONS_DOCUMENT_PATH, '{not json');
    const body = await parseJsonResponse(await GET());
    expect(body.data).toEqual({
      document: null,
      etag: null,
      unavailable: true,
    });
  });

  it('requires If-Match and refuses a stale one', async () => {
    seedDocument();
    expect((await put({ delegations: [] }, null)).status).toBe(400);
    const stale = await put({ delegations: [writeDelegation] }, '"other"');
    expect(stale.status).toBe(409);
    expect((await parseJsonResponse(stale)).code).toBe('DELEGATIONS_CONFLICT');
  });

  it('preserves createdBy/createdAt, stamps the editor, mints ids for new ones and canonicalizes admins', async () => {
    seedDocument();
    const response = await put({
      delegations: [
        writeDelegation,
        {
          label: 'Geneva',
          capabilities: ['announcements'],
          admins: [
            { mail: '  Sender@Geneva.MSF.org ', grants: ['announcements'] },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    const written = blobs.read<{ delegations: Array<Record<string, any>> }>(
      DELEGATIONS_DOCUMENT_PATH,
    )!.delegations;
    expect(written[0]).toMatchObject({
      createdBy: 'first@example.com',
      updatedBy: 'global@example.com',
    });
    expect(written[1].id).toMatch(/^del-[0-9a-f]{12}$/);
    expect(written[1].admins).toEqual([
      { mail: 'sender@geneva.msf.org', grants: ['announcements'] },
    ]);
    expect(written[1].createdBy).toBe('global@example.com');
    expect(limitsInvalidate).toHaveBeenCalled();
    expect(delegationsInvalidate).toHaveBeenCalled();
  });

  it('rejects unknown keys, unknown grants and an admin listed twice', async () => {
    seedDocument();
    expect(
      (await put({ delegations: [{ ...writeDelegation, superuser: true }] }))
        .status,
    ).toBe(400);
    expect(
      (
        await put({
          delegations: [{ ...writeDelegation, capabilities: ['everything'] }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put({
          delegations: [
            {
              ...writeDelegation,
              admins: [
                { mail: 'a@x.org', grants: 'all' },
                { mail: 'A@x.org', grants: ['limits'] },
              ],
            },
          ],
        })
      ).status,
    ).toBe(400);
  });

  it('refuses to delete a delegation — or remove its limits capability — while it owns limit overrides', async () => {
    seedDocument();
    seedPolicy([scopedOverride('lim-000000000001', DEL)]);

    const deleted = await put({ delegations: [] });
    expect(deleted.status).toBe(400);
    expect((await parseJsonResponse(deleted)).code).toBe(
      'DELEGATION_OWNS_OVERRIDES',
    );

    const stripped = await put({
      delegations: [{ ...writeDelegation, capabilities: ['announcements'] }],
    });
    expect((await parseJsonResponse(stripped)).code).toBe(
      'DELEGATION_OWNS_OVERRIDES',
    );

    // Disabling keeps the overrides recognisably scoped-and-inert: allowed.
    expect(
      (await put({ delegations: [{ ...writeDelegation, enabled: false }] }))
        .status,
    ).toBe(200);
  });

  it('keeps delegated override budgets inside the limits policy cap', async () => {
    seedDocument();
    seedPolicy(
      Array.from({ length: 150 }, (_, i) =>
        scopedOverride(`lim-${i.toString(16).padStart(12, '0')}`),
      ),
    );
    const response = await put({
      delegations: [{ ...writeDelegation, limits: { maxOverrides: 100 } }],
    });
    expect(response.status).toBe(400);
    expect((await parseJsonResponse(response)).code).toBe(
      'DELEGATION_BUDGET_EXCEEDED',
    );
  });
});
