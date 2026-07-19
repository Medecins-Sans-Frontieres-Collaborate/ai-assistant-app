import { canonicalAgentKey } from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from '../helpers';

import { GET } from '@/app/api/agent-access/me/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetSnapshot = vi.hoisted(() => vi.fn());
// Global-admin list is read from env at call time by adminAuth — mutable mock.
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
  AGENT_ACCESS_ADMINS: ' Global@Example.com , second@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: serviceEnsureFresh,
      getSnapshot: serviceGetSnapshot,
    }),
  },
}));

const SOURCE =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/projects/proj';
const KEY_A = canonicalAgentKey(SOURCE, 'agent-a');
const KEY_B = canonicalAgentKey(SOURCE, 'agent-b');

function sessionFor(mail: string | undefined) {
  return { user: { id: 'user-1', mail } };
}

function snapshotWithConfig(
  localAdmins: Array<{ email: string; agentKeys: string[] }>,
) {
  return {
    rules: [],
    config: {
      version: 1,
      localAdmins,
      updatedBy: 'global@example.com',
      updatedAt: '2026-07-17T00:00:00.000Z',
    },
    configEtag: '"cfg-e1"',
    rulesUnavailable: false,
    fetchedAt: 1,
  };
}

describe('GET /api/agent-access/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    mockEnv.AGENT_ACCESS_ADMINS = ' Global@Example.com , second@example.com';
    serviceIsEnabled.mockReturnValue(true);
    serviceEnsureFresh.mockResolvedValue(undefined);
    serviceGetSnapshot.mockReturnValue(snapshotWithConfig([]));
    mockAuth.mockResolvedValue(sessionFor('user@example.com'));
  });

  it('returns 401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(serviceEnsureFresh).not.toHaveBeenCalled();
  });

  it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
    serviceIsEnabled.mockReturnValue(false);
    mockAuth.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(404);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(serviceEnsureFresh).not.toHaveBeenCalled();
  });

  it('returns global-admin status with the ALL_AGENT_KEYS sentinel', async () => {
    // Case/whitespace differences must not matter (Graph mail matching).
    mockAuth.mockResolvedValue(sessionFor('global@EXAMPLE.com'));

    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toEqual({
      isGlobalAdmin: true,
      isLocalAdmin: false,
      editableAgentKeys: '*',
    });
  });

  it('returns local-admin status with the union of delegated keys', async () => {
    mockAuth.mockResolvedValue(sessionFor('lead@example.com'));
    serviceGetSnapshot.mockReturnValue(
      snapshotWithConfig([
        { email: ' Lead@Example.com ', agentKeys: [KEY_A] },
        { email: 'lead@example.com', agentKeys: [KEY_B] },
      ]),
    );

    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.isGlobalAdmin).toBe(false);
    expect(data.data.isLocalAdmin).toBe(true);
    expect([...data.data.editableAgentKeys].sort()).toEqual(
      [KEY_A, KEY_B].sort(),
    );
    expect(serviceEnsureFresh).toHaveBeenCalled();
  });

  it('returns non-admin status for a regular user', async () => {
    serviceGetSnapshot.mockReturnValue(
      snapshotWithConfig([{ email: 'lead@example.com', agentKeys: [KEY_A] }]),
    );

    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toEqual({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
  });

  it('returns non-admin status when the session has no mail', async () => {
    mockAuth.mockResolvedValue(sessionFor(undefined));
    serviceGetSnapshot.mockReturnValue(
      snapshotWithConfig([{ email: 'lead@example.com', agentKeys: [KEY_A] }]),
    );

    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toEqual({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
  });
});
