/** Global-admin API gates plus real policy/eligibility validation. */
import { NextRequest } from 'next/server';

import { auxiliaryReport } from '@/__tests__/lib/services/auxiliary/fixtures';
import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import { resolveAuxiliaryCandidate } from '@/lib/services/auxiliary/resolution';
import {
  type AuxiliaryAdminReport,
  ROUTING_OPERATIONS,
} from '@/lib/services/auxiliary/types';

import { GET, POST, PUT } from '@/app/api/admin/auxiliary-models/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  report: vi.fn(),
  probe: vi.fn(),
  write: vi.fn(),
  history: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/config/environment', () => ({
  env: { NEXT_PUBLIC_ENV: 'live', AGENT_ACCESS_ADMINS: 'global@example.com' },
}));
vi.mock('@/lib/services/auxiliary/AuxiliaryModelService', () => ({
  AuxiliaryModelService: {
    getInstance: () => ({
      report: mocks.report,
      probe: mocks.probe,
      invalidate: mocks.invalidate,
    }),
  },
}));
vi.mock('@/lib/services/auxiliary/store', () => ({
  writeAuxiliaryPolicy: mocks.write,
  recordAuxiliaryHistory: mocks.history,
}));
const actor = { user: { mail: 'global@example.com', id: 'global' } };
const request = (
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  new NextRequest('https://localhost/api/admin/auxiliary-models', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...headers },
  });
let report: AuxiliaryAdminReport;
beforeEach(() => {
  vi.clearAllMocks();
  report = auxiliaryReport();
  mocks.auth.mockResolvedValue(actor);
  mocks.report.mockImplementation(async () => report);
  mocks.write.mockResolvedValue('"revision"');
  mocks.history.mockResolvedValue(undefined);
  mocks.probe.mockResolvedValue(report);
});

describe('auxiliary model administration', () => {
  it.each(['GET', 'PUT', 'POST'])(
    '%s rejects missing sessions before touching environment services',
    async (method) => {
      mocks.auth.mockResolvedValue(null);
      const handler = { GET, PUT, POST }[method]!;
      expect((await handler(request(method))).status).toBe(401);
      expect(mocks.report).not.toHaveBeenCalled();
      expect(mocks.probe).not.toHaveBeenCalled();
    },
  );
  it.each(['GET', 'PUT', 'POST'])(
    '%s rejects regular and view-as-demoted admins',
    async (method) => {
      const handler = { GET, PUT, POST }[method]!;
      for (const user of [
        { mail: 'user@example.com' },
        {
          ...actor.user,
          viewAs: { overrides: { adminRole: 'none' }, actual: {} },
        },
      ]) {
        mocks.auth.mockResolvedValue({ user });
        expect((await handler(request(method))).status).toBe(403);
      }
      expect(mocks.report).not.toHaveBeenCalled();
    },
  );
  it('GET reports readiness without implicitly running paid probes', async () => {
    expect((await GET(request('GET'))).status).toBe(200);
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it('CAS-saves only the trusted deployment environment and actor', async () => {
    expect(
      (
        await PUT(
          request(
            'PUT',
            { assignments: report.effective },
            { 'if-match': '"previous"' },
          ),
        )
      ).status,
    ).toBe(200);
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'live',
        updatedBy: actor.user.mail,
      }),
      '"previous"',
    );
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('rejects environment and endpoint injection in policy writes', async () => {
    expect(
      (
        await PUT(
          request('PUT', { environment: 'dev', assignments: report.effective }),
        )
      ).status,
    ).toBe(400);
    const draft = structuredClone(report.effective) as any;
    draft.routing.EU[0].endpoint = 'https://attacker.invalid';
    expect((await PUT(request('PUT', { assignments: draft }))).status).toBe(
      400,
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('does not accept wildcard or malformed If-Match headers', async () => {
    for (const value of ['*', 'unquoted'])
      expect(
        (
          await PUT(
            request(
              'PUT',
              { assignments: report.effective },
              { 'if-match': value },
            ),
          )
        ).status,
      ).toBe(400);
  });
  it('returns a conflict without discarding or rewriting the existing policy', async () => {
    mocks.write.mockRejectedValue(new AgentAccessConflictError('conflict'));
    expect(
      (await PUT(request('PUT', { assignments: report.effective }))).status,
    ).toBe(409);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it('does not confuse an inventory outage with missing deployments', async () => {
    report.inventory[0].status = 'stale';
    expect(
      (await PUT(request('PUT', { assignments: report.effective }))).status,
    ).toBe(503);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('rejects an EU chain without any permitted model', async () => {
    report.inventory[0].models[0].sku = 'GlobalStandard';
    expect(
      (await PUT(request('PUT', { assignments: report.effective }))).status,
    ).toBe(400);
  });
  it('requires checks for new designations, including unknown new GPT deployments', async () => {
    const deployment = {
      ...report.inventory[0].models[0],
      deploymentName: 'new-small',
      modelName: 'gpt-6-small-new',
    };
    report.inventory[0].models.push(deployment);
    const reference = {
      accountBinding: 'EU' as const,
      deploymentName: deployment.deploymentName,
    };
    const draft = structuredClone(report.effective);
    draft.routing.EU = [reference];
    expect((await PUT(request('PUT', { assignments: draft }))).status).toBe(
      400,
    );
    const fingerprint = resolveAuxiliaryCandidate(
      reference,
      report.inventory[0],
      'EU',
    ).candidate!.fingerprint;
    report.observations = ROUTING_OPERATIONS.map((operation) => ({
      key: 'EU:new-small',
      fingerprint,
      operation,
      operationRevision: 1,
      policyRevision: report.revision,
      checkedAt: new Date().toISOString(),
      success: true,
      durationMs: 1,
      source: 'probe',
      fallback: false,
    }));
    expect((await PUT(request('PUT', { assignments: draft }))).status).toBe(
      200,
    );
  });
  it('rejects arbitrary probe input and preserves explicit rate-limit feedback', async () => {
    const body = {
      reference: { accountBinding: 'EU', deploymentName: 'classifier' },
      purpose: 'routing',
      region: 'EU',
    };
    expect(
      (
        await POST(
          request('POST', { ...body, prompt: 'untrusted arbitrary prompt' }),
        )
      ).status,
    ).toBe(400);
    mocks.probe.mockRejectedValue(new Error('PROBE_RATE_LIMIT'));
    expect((await POST(request('POST', body))).status).toBe(429);
  });
});
