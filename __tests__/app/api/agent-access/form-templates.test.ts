import { NextRequest } from 'next/server';

import {
  StoredFormTemplate,
  createAgentAccessBlobStorage,
  deleteFormTemplate,
  listAllFormTemplates,
  readConfig,
  readFormTemplate,
  writeConfig,
  writeFormTemplate,
  writeFormTemplateHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AdminFormTemplate,
  AgentAccessConfig,
  FORM_TEMPLATE_SOURCE,
  canonicalAgentKey,
  formTemplateBlobPath,
} from '@/lib/services/agentAccess/types';
import {
  deleteAdminOriginals,
  readOriginalFile,
  writeAdminOriginalBytes,
} from '@/lib/services/workflows/form/originalFile';

import { parseJsonResponse } from '../helpers';

import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/agent-access/form-templates/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetSnapshot = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: serviceEnsureFresh,
      getSnapshot: serviceGetSnapshot,
      invalidate: serviceInvalidate,
    }),
  },
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
      writeFormTemplate: vi.fn(),
      deleteFormTemplate: vi.fn(),
      writeFormTemplateHistoryEntry: vi.fn(),
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    };
  },
);
vi.mock(
  '@/lib/services/workflows/form/originalFile',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/workflows/form/originalFile')
      >();
    return {
      ...actual,
      readOriginalFile: vi.fn(),
      writeAdminOriginalBytes: vi.fn(),
      deleteAdminOriginal: vi.fn(),
      deleteAdminOriginals: vi.fn(),
    };
  },
);

const ID = 'formtpl-abc123def456';
const ETAG = '"etag-1"';
const SHA = 'a'.repeat(64);

const validBody = {
  name: 'Grant application',
  description: 'Standard grant form',
  sections: [{ id: 'main', heading: 'Main' }],
  fields: [
    {
      id: 'title',
      sectionId: 'main',
      label: 'Title',
      type: 'text',
      required: true,
    },
    {
      id: 'org',
      sectionId: 'main',
      label: 'Organisation',
      type: 'text',
      required: false,
      admin: { locked: true, prefill: { kind: 'constant', value: 'MSF' } },
    },
  ],
  layout: '# {{field:title}}\n\n{{field:org}}',
  rules: ['Title must not be empty'],
};

function makeRecord(
  overrides: Partial<AdminFormTemplate> = {},
): AdminFormTemplate {
  return {
    version: 1,
    id: ID,
    name: validBody.name,
    description: validBody.description,
    template: {
      ...validBody,
      id: ID,
      origin: 'admin',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    createdBy: 'global@example.com',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'global@example.com',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function stored(record: AdminFormTemplate): StoredFormTemplate {
  return {
    canonicalKey: canonicalAgentKey(FORM_TEMPLATE_SOURCE, record.id),
    blobPath: formTemplateBlobPath(record.id),
    record,
    etag: ETAG,
  };
}

const url = 'https://app.example.com/api/agent-access/form-templates';
const postRequest = (body: unknown) =>
  new NextRequest(url, { method: 'POST', body: JSON.stringify(body) });
const putRequest = (body: unknown, ifMatch: string | null = ETAG) =>
  new NextRequest(url, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: ifMatch === null ? {} : { 'if-match': ifMatch },
  });
const deleteRequest = (id: string, ifMatch: string | null = ETAG) =>
  new NextRequest(`${url}?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: ifMatch === null ? {} : { 'if-match': ifMatch },
  });

const emptyConfig: AgentAccessConfig = {
  version: 1,
  localAdmins: [],
  updatedBy: 'global@example.com',
  updatedAt: '2026-07-23T00:00:00.000Z',
};

describe('/api/agent-access/form-templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    serviceIsEnabled.mockReturnValue(true);
    serviceGetSnapshot.mockReturnValue({ config: emptyConfig });
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'global@example.com' },
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    vi.mocked(listAllFormTemplates).mockResolvedValue([]);
    vi.mocked(readConfig).mockResolvedValue({
      config: emptyConfig,
      etag: '"cfg"',
    });
    vi.mocked(writeConfig).mockResolvedValue('"cfg2"');
    vi.mocked(writeFormTemplate).mockResolvedValue(ETAG);
    vi.mocked(deleteFormTemplate).mockResolvedValue(true);
    vi.mocked(writeFormTemplateHistoryEntry).mockResolvedValue(undefined);
    vi.mocked(readOriginalFile).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      ext: 'docx',
    });
    vi.mocked(writeAdminOriginalBytes).mockResolvedValue(undefined);
    vi.mocked(deleteAdminOriginals).mockResolvedValue(undefined);
  });

  it('gates: 404 disabled, 401 anonymous, 403 non-admin', async () => {
    serviceIsEnabled.mockReturnValue(false);
    expect((await GET()).status).toBe(404);
    serviceIsEnabled.mockReturnValue(true);
    mockAuth.mockResolvedValue(null);
    expect((await POST(postRequest(validBody))).status).toBe(401);
    mockAuth.mockResolvedValue({
      user: { id: 'u2', mail: 'nobody@example.com' },
    });
    expect((await GET()).status).toBe(403);
    expect((await POST(postRequest(validBody))).status).toBe(403);
  });

  it('rejects an invalid template body with the workflow schema', async () => {
    const bad = {
      ...validBody,
      fields: [{ ...validBody.fields[0], sectionId: 'ghost' }],
    };
    const response = await POST(postRequest(bad));
    expect(response.status).toBe(400);
    const dup = {
      ...validBody,
      fields: [validBody.fields[0], validBody.fields[0]],
    };
    expect((await POST(postRequest(dup))).status).toBe(400);
    const extra = { ...validBody, id: 'client-chosen' };
    expect((await POST(postRequest(extra))).status).toBe(400);
  });

  it('creates with a server-minted id, admin origin and history', async () => {
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data.record.id).toMatch(/^formtpl-[a-f0-9]{12}$/);
    expect(body.data.record.template.origin).toBe('admin');
    expect(body.data.record.template.id).toBe(body.data.record.id);
    expect(body.data.record.template.rules).toEqual([
      'Title must not be empty',
    ]);
    expect(vi.mocked(writeFormTemplate).mock.calls[0][2]).toBeNull();
    expect(writeFormTemplateHistoryEntry).toHaveBeenCalledTimes(1);
    expect(serviceInvalidate).toHaveBeenCalled();
    expect(readOriginalFile).not.toHaveBeenCalled();
  });

  it('copies a freshly uploaded original into the admin store and rewrites the ref', async () => {
    const response = await POST(
      postRequest({
        ...validBody,
        original: {
          fileId: `/api/file/${SHA}.docx`,
          name: 'form.docx',
          mime: 'docx',
          fillMode: 'docx-controls',
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    const id = body.data.record.id as string;
    expect(readOriginalFile).toHaveBeenCalledWith(
      expect.anything(),
      `/api/file/${SHA}.docx`,
      expect.anything(),
    );
    expect(writeAdminOriginalBytes).toHaveBeenCalledWith(
      id,
      'docx',
      expect.any(Uint8Array),
    );
    expect(body.data.record.template.original.fileId).toBe(`admin:${id}.docx`);
  });

  it('refuses an original that belongs to another template', async () => {
    vi.mocked(readFormTemplate).mockResolvedValue({
      record: makeRecord(),
      etag: ETAG,
    });
    const response = await PUT(
      putRequest({
        ...validBody,
        id: ID,
        original: {
          fileId: 'admin:formtpl-000000000000.docx',
          name: 'x.docx',
          mime: 'docx',
          fillMode: 'docx-controls',
        },
      }),
    );
    expect(response.status).toBe(400);
  });

  it('PUT requires a strong If-Match, keeps createdBy, writes with CAS', async () => {
    vi.mocked(readFormTemplate).mockResolvedValue({
      record: makeRecord({ createdBy: 'first@example.com' }),
      etag: ETAG,
    });
    expect((await PUT(putRequest({ ...validBody, id: ID }, null))).status).toBe(
      400,
    );
    const response = await PUT(
      putRequest({ ...validBody, id: ID, name: 'Renamed' }),
    );
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data.record.createdBy).toBe('first@example.com');
    expect(body.data.record.name).toBe('Renamed');
    expect(vi.mocked(writeFormTemplate).mock.calls[0][2]).toBe(ETAG);
  });

  it('PUT 404s an unknown id and rejects a malformed id', async () => {
    vi.mocked(readFormTemplate).mockResolvedValue(null);
    expect((await PUT(putRequest({ ...validBody, id: ID }))).status).toBe(404);
    expect((await PUT(putRequest({ ...validBody, id: 'nope' }))).status).toBe(
      400,
    );
  });

  it('lists only keys a local admin may edit', async () => {
    const other = makeRecord({ id: 'formtpl-000000000001' });
    vi.mocked(listAllFormTemplates).mockResolvedValue([
      stored(makeRecord()),
      stored(other),
    ]);
    const config: AgentAccessConfig = {
      ...emptyConfig,
      localAdmins: [
        {
          email: 'local@example.com',
          agentKeys: [canonicalAgentKey(FORM_TEMPLATE_SOURCE, ID)],
        },
      ],
    };
    vi.mocked(readConfig).mockResolvedValue({ config, etag: '"cfg"' });
    mockAuth.mockResolvedValue({
      user: { id: 'u5', mail: 'local@example.com' },
    });
    const body = await parseJsonResponse(await GET());
    expect(
      body.data.templates.map((t: { record: { id: string } }) => t.record.id),
    ).toEqual([ID]);
  });

  it('DELETE removes the record and its original, and audits history', async () => {
    vi.mocked(readFormTemplate).mockResolvedValue({
      record: makeRecord({
        template: {
          ...makeRecord().template,
          original: {
            fileId: `admin:${ID}.pdf`,
            name: 'f.pdf',
            mime: 'pdf',
            fillMode: 'pdf-acroform',
          },
        },
      }),
      etag: ETAG,
    });
    const response = await DELETE(deleteRequest(ID));
    expect(response.status).toBe(200);
    expect(deleteFormTemplate).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      ETAG,
    );
    const history = vi.mocked(writeFormTemplateHistoryEntry).mock.calls[0][1];
    expect(history.action).toBe('delete');
    expect(history.record).toBeNull();
  });
});
