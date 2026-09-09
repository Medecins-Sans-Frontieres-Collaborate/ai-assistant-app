import { NextRequest } from 'next/server';

import {
  createWorkflowPolicyBlobStorage,
  readWorkflowPolicy,
  writeWorkflowPolicy,
  writeWorkflowPolicyHistory,
} from '@/lib/services/workflows/policy/workflowPolicyStore';

import { parseJsonResponse } from '../helpers';

import { GET as GET_ME } from '@/app/api/workflows/policy/me/route';
import { GET, PUT } from '@/app/api/workflows/policy/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceAllEnabled = vi.hoisted(() => vi.fn());
const serviceSnapshot = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/workflows/policy/WorkflowPolicyService', () => ({
  WorkflowPolicyService: {
    getInstance: () => ({
      invalidate: serviceInvalidate,
      ensureFresh: serviceEnsureFresh,
      allEnabled: serviceAllEnabled,
      getSnapshot: serviceSnapshot,
    }),
  },
}));
vi.mock(
  '@/lib/services/workflows/policy/workflowPolicyStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/workflows/policy/workflowPolicyStore')
      >();
    return {
      ...actual,
      createWorkflowPolicyBlobStorage: vi.fn(),
      readWorkflowPolicy: vi.fn(),
      writeWorkflowPolicy: vi.fn(),
      writeWorkflowPolicyHistory: vi.fn(),
    };
  },
);

const globalAdminSession = {
  user: { id: 'oid-1', displayName: 'Global', mail: 'global@example.com' },
};
const demotedAdminSession = {
  user: {
    ...globalAdminSession.user,
    viewAs: { overrides: { adminRole: 'none' }, actual: {} },
  },
};
const normalSession = {
  user: { id: 'oid-2', displayName: 'User', mail: 'user@example.com' },
};

function putRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/workflows/policy', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const validBody = {
  workflows: {
    translation: { enabled: true },
    document: { enabled: true },
    'data-analysis': { enabled: true },
    map: { enabled: false },
    grants: { enabled: true },
  },
};

describe('/api/workflows/policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(globalAdminSession);
    vi.mocked(createWorkflowPolicyBlobStorage).mockReturnValue({} as never);
    vi.mocked(writeWorkflowPolicy).mockResolvedValue('"etag-new"');
    vi.mocked(writeWorkflowPolicyHistory).mockResolvedValue(undefined);
  });

  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(putRequest(validBody))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    mockAuth.mockResolvedValue(normalSession);
    expect((await GET()).status).toBe(403);
    expect((await PUT(putRequest(validBody))).status).toBe(403);
  });

  it('403s for a global admin currently viewing as a regular user', async () => {
    mockAuth.mockResolvedValue(demotedAdminSession);
    expect((await GET()).status).toBe(403);
    expect((await PUT(putRequest(validBody))).status).toBe(403);
  });

  it('GET reports policyUnavailable on a read failure rather than "no policy"', async () => {
    vi.mocked(readWorkflowPolicy).mockRejectedValue(new Error('down'));
    const body = await parseJsonResponse(await GET());
    expect(body.data.policyUnavailable).toBe(true);
    expect(body.data.policy).toBeNull();
  });

  it('PUT rejects unknown workflow keys and bad shapes', async () => {
    expect(
      (await PUT(putRequest({ workflows: { bogus: { enabled: true } } })))
        .status,
    ).toBe(400);
    expect(
      (await PUT(putRequest({ workflows: { grants: { enabled: 'yes' } } })))
        .status,
    ).toBe(400);
    expect(
      (await PUT(putRequest(validBody, { 'if-match': 'W/"weak"' }))).status,
    ).toBe(400);
  });

  it('PUT writes with CAS, stamps the author, audits, and invalidates', async () => {
    const response = await PUT(
      putRequest(validBody, { 'if-match': '"etag-1"' }),
    );
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data.etag).toBe('"etag-new"');
    expect(body.data.policy.updatedBy).toBe('global@example.com');
    expect(body.data.policy.workflows.map.enabled).toBe(false);
    expect(vi.mocked(writeWorkflowPolicy).mock.calls[0][2]).toBe('"etag-1"');
    expect(writeWorkflowPolicyHistory).toHaveBeenCalledTimes(1);
    expect(serviceInvalidate).toHaveBeenCalledTimes(1);
  });

  it('maps a CAS conflict to 409', async () => {
    const { WorkflowPolicyConflictError } =
      await import('@/lib/services/workflows/policy/workflowPolicyStore');
    vi.mocked(writeWorkflowPolicy).mockRejectedValue(
      new WorkflowPolicyConflictError('conflict'),
    );
    const response = await PUT(putRequest(validBody, { 'if-match': '"old"' }));
    expect(response.status).toBe(409);
    expect((await parseJsonResponse(response)).code).toBe(
      'WORKFLOW_POLICY_CONFLICT',
    );
  });
});

describe('/api/workflows/policy/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceEnsureFresh.mockResolvedValue(undefined);
    serviceAllEnabled.mockReturnValue({ grants: false, map: true });
    serviceSnapshot.mockReturnValue({ policyUnavailable: false });
  });

  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET_ME()).status).toBe(401);
  });

  it('returns the effective map for any signed-in user', async () => {
    mockAuth.mockResolvedValue(normalSession);
    const body = await parseJsonResponse(await GET_ME());
    expect(body.data.enabled).toEqual({ grants: false, map: true });
    expect(body.data.policyUnavailable).toBe(false);
    expect(serviceEnsureFresh).toHaveBeenCalled();
  });
});
