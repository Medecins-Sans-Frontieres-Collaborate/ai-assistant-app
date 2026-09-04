/**
 * PUT/DELETE /api/limits/scoped/overrides/[id] — the scoped write path
 * (design §4, §5, §7).
 *
 * Storage is faked at the blobCas level (downloadBlob/uploadJson) so the REAL
 * `mutatePolicy` loop runs: every assertion about re-validation on a CAS
 * retry, the 409 after exhaustion, and the exact document written is about
 * the code that will run in production, not a mock of it.
 */
import { NextRequest } from 'next/server';

import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  LIMITS_HISTORY_PREFIX,
  LIMITS_POLICY_PATH,
  LimitDelegation,
  LimitOverride,
  LimitsPolicy,
  LimitsPolicySchema,
} from '@/lib/services/limits/types';

import { parseJsonResponse } from '../helpers';

import { DELETE, PUT } from '@/app/api/limits/scoped/overrides/[id]/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/limits/LimitsService', () => ({
  LimitsService: { getInstance: () => ({ invalidate: serviceInvalidate }) },
}));
vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: () => ({}),
}));
// Keep AgentAccessConflictError REAL so the 412 → retry → 409 path is genuine.
vi.mock('@/lib/services/agentAccess/blobCas', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/agentAccess/blobCas')>();
  return { ...actual, downloadBlob: vi.fn(), uploadJson: vi.fn() };
});

const DEL_OCP = 'del-0000000000aa';
const DEL_OTHER = 'del-0000000000bb';
const DEL_OFF = 'del-0000000000cc';
const OWN_ID = 'lim-0000000000a1';
const NEW_ID = 'lim-0000000000a2';
const OTHER_ID = 'lim-0000000000b1';
const GLOBAL_ID = 'lim-0000000000c1';
const OCP_ADMIN = 'ocp-admin@ocp.msf.org';

const STAMP = {
  createdBy: 'global@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'global@example.com',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function delegation(
  id: string,
  extra: Partial<LimitDelegation> = {},
): LimitDelegation {
  return {
    id,
    label: id,
    enabled: true,
    admins: [OCP_ADMIN],
    jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
    maxOverrides: 25,
    ...STAMP,
    ...extra,
  };
}

function override(
  id: string,
  extra: Partial<LimitOverride> = {},
): LimitOverride {
  return {
    id,
    label: 'stored',
    enabled: true,
    scope: 'user',
    targets: ['a@ocp.msf.org'],
    priority: 0,
    entries: [{ limitKey: 'chat.messagesPerDay', value: 5, ceiling: false }],
    ...STAMP,
    createdBy: 'original-author@ocp.msf.org',
    createdAt: '2025-06-01T00:00:00.000Z',
    ...extra,
  };
}

function policyWith(input: Partial<LimitsPolicy> = {}): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults: [{ limitKey: 'chat.messagesPerDay', value: 100 }],
    delegations: [
      delegation(DEL_OCP),
      delegation(DEL_OTHER, { admins: ['other@paris.msf.org'] }),
      delegation(DEL_OFF, { enabled: false }),
    ],
    overrides: [
      override(OWN_ID, { delegationId: DEL_OCP }),
      override(OTHER_ID, { delegationId: DEL_OTHER }),
      override(GLOBAL_ID, { label: 'global rule' }),
    ],
    updatedBy: 'global@example.com',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  });
}

function stored(policy: LimitsPolicy | null, etag = '"e1"') {
  if (policy === null) {
    vi.mocked(downloadBlob).mockResolvedValue(null);
    return;
  }
  vi.mocked(downloadBlob).mockResolvedValue({
    buffer: Buffer.from(JSON.stringify(policy), 'utf8'),
    etag,
  });
}

/** The policy document handed to the LAST upload of `policy.json`. */
function writtenPolicy(): LimitsPolicy {
  const calls = vi
    .mocked(uploadJson)
    .mock.calls.filter(([, path]) => path === LIMITS_POLICY_PATH);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][2] as LimitsPolicy;
}

function historyUploads() {
  return vi
    .mocked(uploadJson)
    .mock.calls.filter(([, path]) => path.startsWith(LIMITS_HISTORY_PREFIX));
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function putRequest(id: string, body: unknown, delegationId = DEL_OCP) {
  return new NextRequest(
    `http://localhost/api/limits/scoped/overrides/${id}?delegation=${delegationId}`,
    {
      method: 'PUT',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
  );
}

function deleteRequest(id: string) {
  return new NextRequest(`http://localhost/api/limits/scoped/overrides/${id}`, {
    method: 'DELETE',
  });
}

const validBody = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: 'OCP interns',
  scope: 'user',
  targets: ['intern@ocp.msf.org'],
  entries: [{ limitKey: 'chat.messagesPerDay', value: 20 }],
  ...extra,
});

const ocpSession = {
  user: { id: 'oid-ocp', displayName: 'OCP Admin', mail: OCP_ADMIN },
};

describe('/api/limits/scoped/overrides/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    mockAuth.mockResolvedValue(ocpSession);
    stored(policyWith());
    vi.mocked(uploadJson).mockResolvedValue('"e2"');
  });

  describe('authorization and shape', () => {
    it('401s without a session, 403s without a mail', async () => {
      mockAuth.mockResolvedValue(null);
      expect(
        (await PUT(putRequest(NEW_ID, validBody(NEW_ID)), params(NEW_ID)))
          .status,
      ).toBe(401);
      mockAuth.mockResolvedValue({ user: { id: 'x', displayName: 'X' } });
      expect(
        (await PUT(putRequest(NEW_ID, validBody(NEW_ID)), params(NEW_ID)))
          .status,
      ).toBe(403);
      expect(uploadJson).not.toHaveBeenCalled();
    });

    it('400s a malformed path id, delegation param, body, or mismatched body id', async () => {
      expect(
        (await PUT(putRequest('nope', validBody('nope')), params('nope')))
          .status,
      ).toBe(400);
      expect(
        (
          await PUT(
            putRequest(NEW_ID, validBody(NEW_ID), 'del-zz'),
            params(NEW_ID),
          )
        ).status,
      ).toBe(400);
      expect(
        (await PUT(putRequest(NEW_ID, 'not json'), params(NEW_ID))).status,
      ).toBe(400);
      expect(
        (await PUT(putRequest(NEW_ID, validBody(OWN_ID)), params(NEW_ID)))
          .status,
      ).toBe(400);
      expect(downloadBlob).not.toHaveBeenCalled();
    });

    it('refuses the escalation levers by SHAPE: delegationId, priority ≠ 0, ceiling: true, createdBy', async () => {
      for (const extra of [
        { delegationId: DEL_OTHER },
        { priority: 5 },
        { createdBy: 'me' },
        {
          entries: [
            { limitKey: 'chat.messagesPerDay', value: 20, ceiling: true },
          ],
        },
      ]) {
        const response = await PUT(
          putRequest(NEW_ID, validBody(NEW_ID, extra)),
          params(NEW_ID),
        );
        expect(response.status).toBe(400);
        expect((await parseJsonResponse(response)).code).toBe('BAD_REQUEST');
      }
      expect(uploadJson).not.toHaveBeenCalled();
    });

    it('tolerates the normalized client body: priority 0 and ceiling false', async () => {
      const response = await PUT(
        putRequest(
          NEW_ID,
          validBody(NEW_ID, {
            priority: 0,
            entries: [
              { limitKey: 'chat.messagesPerDay', value: 20, ceiling: false },
            ],
          }),
        ),
        params(NEW_ID),
      );
      expect(response.status).toBe(200);
    });
  });

  describe('delegation checks (re-run on every CAS round)', () => {
    it('400s an unknown delegation', async () => {
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID), 'del-ffffffffffff'),
        params(NEW_ID),
      );
      expect(response.status).toBe(400);
    });

    it('403s a delegation the caller is not named in', async () => {
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID), DEL_OTHER),
        params(NEW_ID),
      );
      expect(response.status).toBe(403);
      expect((await parseJsonResponse(response)).code).toBe('FORBIDDEN');
      expect(uploadJson).not.toHaveBeenCalled();
    });

    it('403s writes under a DISABLED delegation even though the caller is named in it', async () => {
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID), DEL_OFF),
        params(NEW_ID),
      );
      expect(response.status).toBe(403);
      expect(uploadJson).not.toHaveBeenCalled();
    });

    it('403s when no policy exists — a scoped admin never creates the document', async () => {
      stored(null);
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID)),
        params(NEW_ID),
      );
      expect(response.status).toBe(403);
      expect(uploadJson).not.toHaveBeenCalled();
    });
  });

  describe('foreign overrides (§4 last bullet)', () => {
    it('403s LIMITS_FOREIGN_OVERRIDE for an id owned by another delegation, and never overwrites it', async () => {
      const response = await PUT(
        putRequest(OTHER_ID, validBody(OTHER_ID)),
        params(OTHER_ID),
      );
      expect(response.status).toBe(403);
      expect((await parseJsonResponse(response)).code).toBe(
        'LIMITS_FOREIGN_OVERRIDE',
      );
      expect(uploadJson).not.toHaveBeenCalled();
    });

    it('403s LIMITS_FOREIGN_OVERRIDE for a GLOBAL-tier id (no delegationId)', async () => {
      const response = await PUT(
        putRequest(GLOBAL_ID, validBody(GLOBAL_ID)),
        params(GLOBAL_ID),
      );
      expect(response.status).toBe(403);
      expect((await parseJsonResponse(response)).code).toBe(
        'LIMITS_FOREIGN_OVERRIDE',
      );
      expect(uploadJson).not.toHaveBeenCalled();
    });
  });

  describe('verdicts (§4)', () => {
    it('400s LIMITS_OUT_OF_SCOPE naming each provably-outside target, logs it, writes nothing', async () => {
      const response = await PUT(
        putRequest(
          NEW_ID,
          validBody(NEW_ID, {
            targets: ['ok@ocp.msf.org', 'eve@elsewhere.org', 'x@y.org'],
          }),
        ),
        params(NEW_ID),
      );
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(400);
      expect(body.code).toBe('LIMITS_OUT_OF_SCOPE');
      expect(body.details).toEqual({
        outOfScope: ['eve@elsewhere.org', 'x@y.org'],
      });
      expect(uploadJson).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('action=scoped-rejected'),
      );
    });

    it('rejects an out-of-scope domain target', async () => {
      const response = await PUT(
        putRequest(
          NEW_ID,
          validBody(NEW_ID, { scope: 'domain', targets: ['elsewhere.org'] }),
        ),
        params(NEW_ID),
      );
      expect(response.status).toBe(400);
      expect((await parseJsonResponse(response)).code).toBe(
        'LIMITS_OUT_OF_SCOPE',
      );
    });

    it('allows cross-axis group/attribute targets with an undecidable verdict', async () => {
      const response = await PUT(
        putRequest(
          NEW_ID,
          validBody(NEW_ID, {
            scope: 'attribute',
            targets: ['department:health'],
          }),
        ),
        params(NEW_ID),
      );
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(200);
      expect(body.data.verdicts).toEqual([
        {
          target: 'department:health',
          status: 'undecidable',
          reason: 'cross-axis',
        },
      ]);
    });

    it('allows a user target under a group-anchored jurisdiction (undecidable, not rejected)', async () => {
      stored(
        policyWith({
          delegations: [
            delegation(DEL_OCP, {
              jurisdiction: [{ scope: 'group', targets: ['g-1'] }],
            }),
          ],
          overrides: [],
        }),
      );
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID, { targets: ['eve@x.org'] })),
        params(NEW_ID),
      );
      expect(response.status).toBe(200);
      expect(
        (await parseJsonResponse(response)).data.verdicts[0],
      ).toMatchObject({
        status: 'undecidable',
        reason: 'group-or-attribute-jurisdiction',
      });
    });
  });

  describe('budget (§5)', () => {
    it('400s LIMITS_BUDGET_EXCEEDED when the delegation’s maxOverrides is used up (creates only)', async () => {
      stored(
        policyWith({
          delegations: [delegation(DEL_OCP, { maxOverrides: 1 })],
          overrides: [override(OWN_ID, { delegationId: DEL_OCP })],
        }),
      );
      const create = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID)),
        params(NEW_ID),
      );
      expect(create.status).toBe(400);
      expect((await parseJsonResponse(create)).code).toBe(
        'LIMITS_BUDGET_EXCEEDED',
      );
      // A lowered budget blocks additions, not edits of what is already there.
      const replace = await PUT(
        putRequest(OWN_ID, validBody(OWN_ID)),
        params(OWN_ID),
      );
      expect(replace.status).toBe(200);
    });

    it('400s LIMITS_BUDGET_EXCEEDED at the document cap so the next global PUT still validates', async () => {
      const filler = Array.from({ length: 199 }, (_, i) =>
        override(`lim-${(0x1000 + i).toString(16).padStart(12, '0')}`, {
          label: 'global',
        }),
      );
      stored(
        policyWith({
          delegations: [delegation(DEL_OCP, { maxOverrides: 100 })],
          overrides: [...filler, override(OWN_ID, { delegationId: DEL_OCP })],
        }),
      );
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID)),
        params(NEW_ID),
      );
      expect(response.status).toBe(400);
      expect((await parseJsonResponse(response)).details).toContain('200/200');
    });
  });

  describe('successful PUT', () => {
    it('creates under the delegation with server-set tier fields, splicing ONE element and nothing else', async () => {
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID)),
        params(NEW_ID),
      );
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(200);
      expect(body.data.override).toMatchObject({
        id: NEW_ID,
        label: 'OCP interns',
        delegationId: DEL_OCP,
        priority: 0,
        createdBy: OCP_ADMIN,
        updatedBy: OCP_ADMIN,
        entries: [
          { limitKey: 'chat.messagesPerDay', value: 20, ceiling: false },
        ],
      });
      expect(body.data.verdicts).toEqual([
        {
          target: 'intern@ocp.msf.org',
          status: 'in-scope',
          reason: 'domain-match',
        },
      ]);

      const written = writtenPolicy();
      const before = policyWith();
      expect(written.overrides).toHaveLength(before.overrides.length + 1);
      expect(written.overrides.slice(0, -1)).toEqual(before.overrides);
      // Untouched top-level keys.
      expect(written.defaults).toEqual(before.defaults);
      expect(written.delegations).toEqual(before.delegations);
      expect(written.mode).toBe(before.mode);
      expect(written.updatedBy).toBe(OCP_ADMIN);
      // CAS anchored on the etag we read.
      expect(vi.mocked(uploadJson).mock.calls[0][3]).toBe('"e1"');
    });

    it('replaces an owned override, preserving createdBy/createdAt from STORAGE and clamping to hardCeiling', async () => {
      const response = await PUT(
        putRequest(
          OWN_ID,
          validBody(OWN_ID, {
            entries: [
              { limitKey: 'feature.mcp.roundsPerRequest', value: 9999 },
            ],
          }),
        ),
        params(OWN_ID),
      );
      expect(response.status).toBe(200);
      const written = writtenPolicy();
      const replaced = written.overrides.find((o) => o.id === OWN_ID)!;
      expect(replaced.createdBy).toBe('original-author@ocp.msf.org');
      expect(replaced.createdAt).toBe('2025-06-01T00:00:00.000Z');
      expect(replaced.updatedBy).toBe(OCP_ADMIN);
      expect(replaced.entries[0].value).toBe(25);
      expect(written.overrides).toHaveLength(policyWith().overrides.length);
    });

    it('writes a scoped-upsert history entry at the per-override path, logs raises, and invalidates the cache', async () => {
      await PUT(putRequest(NEW_ID, validBody(NEW_ID)), params(NEW_ID));
      const history = historyUploads();
      expect(history).toHaveLength(1);
      expect(history[0][1]).toContain(NEW_ID);
      expect(history[0][2]).toMatchObject({
        action: 'scoped-upsert',
        delegationId: DEL_OCP,
        overrideId: NEW_ID,
        updatedBy: OCP_ADMIN,
      });
      expect(serviceInvalidate).toHaveBeenCalledTimes(1);
      // 20 < 100 (global default) → no raise; the count still rides the line.
      expect(console.log).toHaveBeenCalledWith(
        expect.stringMatching(
          /action=scoped-upsert delegation=del-0000000000aa override=lim-0000000000a2 by=ocp-admin@ocp\.msf\.org raises=0/,
        ),
      );
    });

    it('counts a raise over the global tier in the audit line', async () => {
      await PUT(
        putRequest(
          NEW_ID,
          validBody(NEW_ID, {
            entries: [{ limitKey: 'chat.messagesPerDay', value: 500 }],
          }),
        ),
        params(NEW_ID),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('raises=1'),
      );
    });
  });

  describe('CAS loop', () => {
    it('re-reads and re-validates after a 412, then succeeds', async () => {
      vi.mocked(uploadJson)
        .mockRejectedValueOnce(new AgentAccessConflictError())
        .mockResolvedValue('"e3"');
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID)),
        params(NEW_ID),
      );
      expect(response.status).toBe(200);
      expect(downloadBlob).toHaveBeenCalledTimes(2);
    });

    it('re-validation catches a delegation narrowed between rounds', async () => {
      vi.mocked(downloadBlob)
        .mockResolvedValueOnce({
          buffer: Buffer.from(JSON.stringify(policyWith()), 'utf8'),
          etag: '"e1"',
        })
        .mockResolvedValueOnce({
          buffer: Buffer.from(
            JSON.stringify(
              policyWith({
                delegations: [
                  delegation(DEL_OCP, {
                    jurisdiction: [
                      { scope: 'domain', targets: ['ocb.msf.org'] },
                    ],
                  }),
                ],
              }),
            ),
            'utf8',
          ),
          etag: '"e2"',
        });
      vi.mocked(uploadJson).mockRejectedValueOnce(
        new AgentAccessConflictError(),
      );
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID)),
        params(NEW_ID),
      );
      expect(response.status).toBe(400);
      expect((await parseJsonResponse(response)).code).toBe(
        'LIMITS_OUT_OF_SCOPE',
      );
      expect(uploadJson).toHaveBeenCalledTimes(1);
    });

    it('a replace whose target vanished between rounds answers 404 rather than resurrecting it', async () => {
      const without = policyWith();
      without.overrides = without.overrides.filter((o) => o.id !== OWN_ID);
      vi.mocked(downloadBlob)
        .mockResolvedValueOnce({
          buffer: Buffer.from(JSON.stringify(policyWith()), 'utf8'),
          etag: '"e1"',
        })
        .mockResolvedValueOnce({
          buffer: Buffer.from(JSON.stringify(without), 'utf8'),
          etag: '"e2"',
        });
      vi.mocked(uploadJson).mockRejectedValueOnce(
        new AgentAccessConflictError(),
      );
      const response = await PUT(
        putRequest(OWN_ID, validBody(OWN_ID)),
        params(OWN_ID),
      );
      expect(response.status).toBe(404);
      expect(uploadJson).toHaveBeenCalledTimes(1);
    });

    it('409s LIMITS_CONFLICT after three lost rounds', async () => {
      vi.mocked(uploadJson).mockRejectedValue(new AgentAccessConflictError());
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID)),
        params(NEW_ID),
      );
      expect(response.status).toBe(409);
      expect((await parseJsonResponse(response)).code).toBe('LIMITS_CONFLICT');
      expect(downloadBlob).toHaveBeenCalledTimes(3);
      expect(serviceInvalidate).not.toHaveBeenCalled();
    });

    it('refuses to spin on a stored document with no ETag (create-only would 412 forever)', async () => {
      stored(policyWith(), '');
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID)),
        params(NEW_ID),
      );
      expect(response.status).toBe(500);
      expect(uploadJson).not.toHaveBeenCalled();
    });

    it('answers 503 LIMITS_POLICY_UNAVAILABLE when the policy cannot be read', async () => {
      vi.mocked(downloadBlob).mockRejectedValue(
        Object.assign(new Error('storage down'), { statusCode: 500 }),
      );
      const response = await PUT(
        putRequest(NEW_ID, validBody(NEW_ID)),
        params(NEW_ID),
      );
      expect(response.status).toBe(503);
      expect((await parseJsonResponse(response)).code).toBe(
        'LIMITS_POLICY_UNAVAILABLE',
      );
    });
  });

  describe('DELETE', () => {
    it('deletes an owned override, writes scoped-delete history and invalidates', async () => {
      const response = await DELETE(deleteRequest(OWN_ID), params(OWN_ID));
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(200);
      expect(body.data).toEqual({ deleted: true });
      const written = writtenPolicy();
      expect(written.overrides.map((o) => o.id)).toEqual([OTHER_ID, GLOBAL_ID]);
      expect(historyUploads()[0][2]).toMatchObject({
        action: 'scoped-delete',
        delegationId: DEL_OCP,
        overrideId: OWN_ID,
      });
      expect(serviceInvalidate).toHaveBeenCalledTimes(1);
    });

    it('403s LIMITS_FOREIGN_OVERRIDE for another delegation’s or a global record — a guessed id deletes nothing', async () => {
      for (const id of [OTHER_ID, GLOBAL_ID]) {
        const response = await DELETE(deleteRequest(id), params(id));
        expect(response.status).toBe(403);
        expect((await parseJsonResponse(response)).code).toBe(
          'LIMITS_FOREIGN_OVERRIDE',
        );
      }
      expect(uploadJson).not.toHaveBeenCalled();
    });

    it('403s a delete under a disabled delegation', async () => {
      stored(
        policyWith({
          delegations: [delegation(DEL_OCP, { enabled: false })],
          overrides: [override(OWN_ID, { delegationId: DEL_OCP })],
        }),
      );
      expect((await DELETE(deleteRequest(OWN_ID), params(OWN_ID))).status).toBe(
        403,
      );
      expect(uploadJson).not.toHaveBeenCalled();
    });

    it('404s an unknown id', async () => {
      expect((await DELETE(deleteRequest(NEW_ID), params(NEW_ID))).status).toBe(
        404,
      );
    });
  });
});
