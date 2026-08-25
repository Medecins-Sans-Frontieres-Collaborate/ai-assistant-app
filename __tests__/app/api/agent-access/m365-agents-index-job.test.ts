/**
 * Route tests for the job endpoints: start (409 when active), step,
 * cancel, status — admin gating through the shared authorizer.
 */
import { NextRequest } from 'next/server';

import { IndexJobActiveError } from '@/lib/services/m365/agentIndexJobService';

import { parseJsonResponse } from '../helpers';

import { POST as cancelPOST } from '@/app/api/agent-access/m365-agents/index/cancel/route';
import { POST as startPOST } from '@/app/api/agent-access/m365-agents/index/route';
import { GET as statusGET } from '@/app/api/agent-access/m365-agents/index/status/route';
import { POST as stepPOST } from '@/app/api/agent-access/m365-agents/index/step/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockService = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  ensureFresh: vi.fn(),
  getSnapshot: vi.fn(),
  invalidate: vi.fn(),
}));
const mockAdminAuth = vi.hoisted(() => ({ resolveAdminStatus: vi.fn() }));
const mockStore = vi.hoisted(() => ({
  createAgentAccessBlobStorage: vi.fn(() => ({})),
  readM365Agent: vi.fn(),
}));
const mockJobs = vi.hoisted(() => ({
  startIndexJob: vi.fn(),
  stepIndexJob: vi.fn(),
  cancelIndexJob: vi.fn(),
  getIndexJobSummary: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mockAuth, getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => mockService },
}));
vi.mock('@/lib/services/agentAccess/adminAuth', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/agentAccess/adminAuth')
    >();
  return { ...actual, ...mockAdminAuth };
});
vi.mock('@/lib/services/agentAccess/accessRulesStore', () => mockStore);
vi.mock('@/lib/services/m365/agentIndexJobService', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/m365/agentIndexJobService')
    >();
  return { ...actual, ...mockJobs };
});

const AGENT_ID = 'm365-abcdefabcdef';
const JOB_ID = 'job-abcdefabcdef';
const session = {
  user: { id: 'u1', mail: 'admin@example.org', name: 'Admin' },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
};
const summary = {
  jobId: JOB_ID,
  agentId: AGENT_ID,
  status: 'running',
  stale: false,
  startedBy: 'admin@example.org',
  startedAt: '2026-08-25T10:00:00.000Z',
  updatedAt: '2026-08-25T10:00:00.000Z',
  total: 3,
  done: 0,
  indexed: 0,
  failed: 0,
  noText: 0,
  missing: 0,
};

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/agent-access/m365-agents/${path}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session as never);
  mockService.isEnabled.mockReturnValue(true);
  mockService.ensureFresh.mockResolvedValue(undefined);
  mockService.getSnapshot.mockReturnValue({
    config: { version: 1, localAdmins: [] },
  });
  mockAdminAuth.resolveAdminStatus.mockReturnValue({
    isGlobalAdmin: true,
    isLocalAdmin: false,
    editableAgentKeys: '*',
  });
  mockStore.readM365Agent.mockResolvedValue({
    m365Agent: { id: AGENT_ID, sources: [] },
    etag: '"e1"',
  });
  mockJobs.startIndexJob.mockResolvedValue(summary);
  mockJobs.stepIndexJob.mockResolvedValue({ ...summary, done: 2 });
  mockJobs.cancelIndexJob.mockResolvedValue({
    ...summary,
    status: 'cancelled',
  });
  mockJobs.getIndexJobSummary.mockResolvedValue(summary);
});

describe('index job routes', () => {
  it('gates every endpoint on the feature flag, session, and admin status', async () => {
    mockService.isEnabled.mockReturnValue(false);
    expect((await startPOST(post('index', { id: AGENT_ID }))).status).toBe(404);
    mockService.isEnabled.mockReturnValue(true);

    mockAuth.mockResolvedValue(null as never);
    expect(
      (await stepPOST(post('index/step', { id: AGENT_ID, jobId: JOB_ID })))
        .status,
    ).toBe(401);
    mockAuth.mockResolvedValue(session as never);

    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
    expect(
      (await cancelPOST(post('index/cancel', { id: AGENT_ID, jobId: JOB_ID })))
        .status,
    ).toBe(403);
    expect(
      (
        await statusGET(
          new NextRequest(
            `http://localhost/api/agent-access/m365-agents/index/status?id=${AGENT_ID}`,
          ),
        )
      ).status,
    ).toBe(403);
    expect(mockJobs.stepIndexJob).not.toHaveBeenCalled();
  });

  it('refuses a local admin who does not hold the key', async () => {
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['m365-agent::m365-000000000000'],
    });
    const response = await startPOST(post('index', { id: AGENT_ID }));
    expect(response.status).toBe(403);
  });

  it('starts a job and reports an already-active one as 409 with a code', async () => {
    const ok = await startPOST(post('index', { id: AGENT_ID }));
    const body = await parseJsonResponse(ok);
    expect(ok.status).toBe(200);
    expect(body.data.job.jobId).toBe(JOB_ID);
    expect(mockJobs.startIndexJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: AGENT_ID }),
      'u1',
      'admin@example.org',
    );

    mockJobs.startIndexJob.mockRejectedValue(
      new IndexJobActiveError(summary as never),
    );
    const busy = await startPOST(post('index', { id: AGENT_ID }));
    const busyBody = await parseJsonResponse(busy);
    expect(busy.status).toBe(409);
    expect(busyBody.code).toBe('M365_INDEX_JOB_ACTIVE');
  });

  it('validates step/cancel bodies and passes the job id through', async () => {
    expect((await stepPOST(post('index/step', { id: AGENT_ID }))).status).toBe(
      400,
    );
    expect(
      (await stepPOST(post('index/step', { id: AGENT_ID, jobId: 'nope' })))
        .status,
    ).toBe(400);

    const stepped = await stepPOST(
      post('index/step', { id: AGENT_ID, jobId: JOB_ID }),
    );
    expect((await parseJsonResponse(stepped)).data.job.done).toBe(2);
    expect(mockJobs.stepIndexJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      AGENT_ID,
      JOB_ID,
    );

    const cancelled = await cancelPOST(
      post('index/cancel', { id: AGENT_ID, jobId: JOB_ID }),
    );
    expect((await parseJsonResponse(cancelled)).data.job.status).toBe(
      'cancelled',
    );

    mockJobs.cancelIndexJob.mockResolvedValue(null);
    expect(
      (await cancelPOST(post('index/cancel', { id: AGENT_ID, jobId: JOB_ID })))
        .status,
    ).toBe(404);
  });

  it('serves the status summary (null when never indexed)', async () => {
    const response = await statusGET(
      new NextRequest(
        `http://localhost/api/agent-access/m365-agents/index/status?id=${AGENT_ID}`,
      ),
    );
    expect((await parseJsonResponse(response)).data.job.jobId).toBe(JOB_ID);
    mockJobs.getIndexJobSummary.mockResolvedValue(null);
    const none = await statusGET(
      new NextRequest(
        `http://localhost/api/agent-access/m365-agents/index/status?id=${AGENT_ID}`,
      ),
    );
    expect((await parseJsonResponse(none)).data.job).toBeNull();
  });
});
