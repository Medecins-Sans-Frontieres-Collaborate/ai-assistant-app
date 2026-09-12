import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  listAllFormTemplates,
  readFormTemplate,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AdminFormTemplate,
  FORM_TEMPLATE_SOURCE,
  canonicalAgentKey,
  formTemplateBlobPath,
} from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from './helpers';

import { GET as GET_ONE } from '@/app/api/form-templates/[id]/route';
import { GET as GET_LIST } from '@/app/api/form-templates/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceEvaluateAccess = vi.hoisted(() => vi.fn());
const mockResolveGroups = vi.hoisted(() => vi.fn());
const mockWorkflowEnabled = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: serviceEnsureFresh,
      evaluateAccess: serviceEvaluateAccess,
    }),
  },
}));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: mockResolveGroups,
}));
vi.mock('@/lib/services/workflows/policy/guard', () => ({
  isWorkflowEnabled: mockWorkflowEnabled,
}));
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/agentAccess/accessRulesStore')
      >();
    return {
      ...actual,
      createAgentAccessBlobStorage: vi.fn(),
      listAllFormTemplates: vi.fn(),
      readFormTemplate: vi.fn(),
    };
  },
);

const ID_A = 'formtpl-aaaaaaaaaaaa';
const ID_B = 'formtpl-bbbbbbbbbbbb';

function record(id: string, name: string, valid = true): AdminFormTemplate {
  return {
    version: 1,
    id,
    name,
    description: '',
    template: valid
      ? {
          id,
          name,
          sections: [{ id: 's', heading: 'S' }],
          fields: [
            {
              id: 'a',
              sectionId: 's',
              label: 'A',
              type: 'text',
              required: true,
            },
          ],
          layout: '{{field:a}}',
          origin: 'admin',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
        }
      : { broken: true },
    createdBy: 'admin@example.com',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'admin@example.com',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

const storedOf = (r: AdminFormTemplate) => ({
  canonicalKey: canonicalAgentKey(FORM_TEMPLATE_SOURCE, r.id),
  blobPath: formTemplateBlobPath(r.id),
  record: r,
  etag: '"e"',
});

const listRequest = () =>
  new NextRequest('https://app.example.com/api/form-templates');
const oneRequest = (id: string) =>
  new NextRequest(`https://app.example.com/api/form-templates/${id}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('/api/form-templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceIsEnabled.mockReturnValue(true);
    mockWorkflowEnabled.mockResolvedValue(true);
    mockResolveGroups.mockResolvedValue([]);
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'user@example.com' },
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    vi.mocked(listAllFormTemplates).mockResolvedValue([
      storedOf(record(ID_A, 'Allowed')),
      storedOf(record(ID_B, 'Denied')),
      storedOf(record('formtpl-cccccccccccc', 'Broken', false)),
    ]);
    serviceEvaluateAccess.mockImplementation(
      ({ agentName }: { agentName: string }) => ({
        decision: agentName === ID_A ? 'allow' : 'deny',
        reason: 'test',
      }),
    );
  });

  it('lists only allowed, coherent templates as metadata', async () => {
    const body = await parseJsonResponse(await GET_LIST(listRequest()));
    expect(body.data.templates).toEqual([
      {
        id: ID_A,
        name: 'Allowed',
        description: '',
        language: undefined,
        fieldCount: 1,
        fillMode: 'none',
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
    ]);
    // Group warm-up precedes the access filter.
    expect(mockResolveGroups).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when the feature or the workflow is off, 401 when anonymous', async () => {
    mockWorkflowEnabled.mockResolvedValue(false);
    expect(
      (await parseJsonResponse(await GET_LIST(listRequest()))).data.templates,
    ).toEqual([]);
    expect((await GET_ONE(oneRequest(ID_A), params(ID_A))).status).toBe(404);
    mockWorkflowEnabled.mockResolvedValue(true);
    serviceIsEnabled.mockReturnValue(false);
    expect(
      (await parseJsonResponse(await GET_LIST(listRequest()))).data.templates,
    ).toEqual([]);
    mockAuth.mockResolvedValue(null);
    expect((await GET_LIST(listRequest())).status).toBe(401);
  });

  it('loads an allowed template in full and 404s denied or missing ones identically', async () => {
    vi.mocked(readFormTemplate).mockImplementation(async (_s, id) =>
      id === ID_A || id === ID_B
        ? { record: record(id, 'X'), etag: '"e"' }
        : null,
    );
    const ok = await GET_ONE(oneRequest(ID_A), params(ID_A));
    expect(ok.status).toBe(200);
    expect((await parseJsonResponse(ok)).data.template.origin).toBe('admin');

    const denied = await GET_ONE(oneRequest(ID_B), params(ID_B));
    expect(denied.status).toBe(404);
    // Access is decided before storage is touched.
    expect(readFormTemplate).not.toHaveBeenCalledWith(expect.anything(), ID_B);

    const missing = await GET_ONE(
      oneRequest('formtpl-dddddddddddd'),
      params('formtpl-dddddddddddd'),
    );
    expect(missing.status).toBe(404);
    expect((await GET_ONE(oneRequest('bad'), params('bad'))).status).toBe(400);
  });
});
