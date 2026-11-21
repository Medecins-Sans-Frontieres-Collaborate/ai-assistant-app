import { NextRequest } from 'next/server';

import {
  StoredBrandBook,
  createAgentAccessBlobStorage,
  deleteBrandBook,
  listAllBrandBooks,
  readBrandBook,
  readConfig,
  writeBrandBook,
  writeBrandBookHistoryEntry,
  writeConfig,
} from '@/lib/services/agentAccess/accessRulesStore';
import { delegateToCreator } from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  AdminBrandBook,
  AgentAccessConfig,
  BRAND_BOOK_SOURCE,
  brandBookBlobPath,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import {
  BrandFileError,
  removeUnusedBrandBookFiles,
  settleBrandBookFiles,
} from '@/lib/services/brand/brandBooks';

import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';

import { parseJsonResponse } from '../helpers';

import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/agent-access/brand-books/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Admin CRUD of brand books, the form template way: server-minted ids,
 * strong ETags, per-key rights, history, and a local admin's new book
 * delegated to them or rolled back. Files are settled before the write
 * and tidied after it.
 */

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
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
      ensureFresh: vi.fn(),
      getSnapshot: serviceGetSnapshot,
      invalidate: serviceInvalidate,
    }),
  },
}));
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createAgentAccessBlobStorage: vi.fn(),
    listAllBrandBooks: vi.fn(),
    readBrandBook: vi.fn(),
    writeBrandBook: vi.fn(),
    deleteBrandBook: vi.fn(),
    writeBrandBookHistoryEntry: vi.fn(),
    readConfig: vi.fn(),
    writeConfig: vi.fn(),
  }),
);
vi.mock(
  '@/lib/services/agentAccess/adminRouteHelpers',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    delegateToCreator: vi.fn(),
  }),
);
vi.mock('@/lib/services/brand/brandBooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  settleBrandBookFiles: vi.fn(),
  removeUnusedBrandBookFiles: vi.fn(),
}));

const ID = 'brand-abc123def456';
const ETAG = '"etag-1"';
const book = {
  name: 'Northwind',
  palette: [{ name: 'Teal', hex: '0F7C80' }],
  logos: [
    { id: 'main', name: 'Logo', file: `/api/file/${'a'.repeat(64)}.png` },
  ],
};

function makeRecord(overrides: Partial<AdminBrandBook> = {}): AdminBrandBook {
  const parsed = parseBrandBookBody(book);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    version: 1,
    id: ID,
    book: parsed.body,
    createdBy: 'global@example.com',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedBy: 'global@example.com',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const stored = (record: AdminBrandBook): StoredBrandBook => ({
  canonicalKey: canonicalAgentKey(BRAND_BOOK_SOURCE, record.id),
  blobPath: brandBookBlobPath(record.id),
  record,
  etag: ETAG,
});

const url = 'https://app.example.com/api/agent-access/brand-books';
const post = (body: unknown) =>
  new NextRequest(url, { method: 'POST', body: JSON.stringify(body) });
const put = (body: unknown, ifMatch: string | null = ETAG) =>
  new NextRequest(url, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: ifMatch === null ? {} : { 'if-match': ifMatch },
  });
const remove = (id: string, ifMatch: string | null = ETAG) =>
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
const localConfig: AgentAccessConfig = {
  ...emptyConfig,
  localAdmins: [
    {
      email: 'local@example.com',
      agentKeys: [canonicalAgentKey(BRAND_BOOK_SOURCE, ID)],
    },
  ],
};

describe('/api/agent-access/brand-books', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceIsEnabled.mockReturnValue(true);
    serviceGetSnapshot.mockReturnValue({ config: emptyConfig });
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'global@example.com' },
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    vi.mocked(listAllBrandBooks).mockResolvedValue([]);
    vi.mocked(readConfig).mockResolvedValue({
      config: emptyConfig,
      etag: '"cfg"',
    });
    vi.mocked(writeConfig).mockResolvedValue('"cfg2"');
    vi.mocked(writeBrandBook).mockResolvedValue(ETAG);
    vi.mocked(deleteBrandBook).mockResolvedValue(true);
    vi.mocked(writeBrandBookHistoryEntry).mockResolvedValue(undefined);
    vi.mocked(delegateToCreator).mockResolvedValue(true);
    vi.mocked(settleBrandBookFiles).mockImplementation(
      async (_session, id, body) => ({
        ...body,
        logos: body.logos.map((logo) => ({
          ...logo,
          file: `admin:${id}/${'b'.repeat(32)}.png`,
        })),
      }),
    );
    vi.mocked(removeUnusedBrandBookFiles).mockResolvedValue(undefined);
  });

  it('gates: 404 disabled, 401 anonymous, 403 non-admin', async () => {
    serviceIsEnabled.mockReturnValue(false);
    expect((await GET()).status).toBe(404);
    serviceIsEnabled.mockReturnValue(true);
    mockAuth.mockResolvedValue(null);
    expect((await POST(post({ book }))).status).toBe(401);
    mockAuth.mockResolvedValue({
      user: { id: 'u2', mail: 'nobody@example.com' },
    });
    expect((await GET()).status).toBe(403);
    expect((await POST(post({ book }))).status).toBe(403);
  });

  it('refuses an invalid book, naming where', async () => {
    const response = await POST(
      post({ book: { ...book, palette: [{ name: 'X', hex: 'teal' }] } }),
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('palette.0.hex');
    expect(writeBrandBook).not.toHaveBeenCalled();
  });

  it('creates with a server-minted id, settled files and history', async () => {
    const response = await POST(post({ book }));
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data.record.id).toMatch(/^brand-[a-f0-9]{12}$/);
    expect(body.data.record.book.palette[0].hex).toBe('#0f7c80');
    expect(body.data.record.book.logos[0].file).toBe(
      `admin:${body.data.record.id}/${'b'.repeat(32)}.png`,
    );
    expect(vi.mocked(writeBrandBook).mock.calls[0][2]).toBeNull();
    expect(writeBrandBookHistoryEntry).toHaveBeenCalledTimes(1);
    // A global admin needs no delegation.
    expect(delegateToCreator).not.toHaveBeenCalled();
  });

  it('answers 400 with the reason when a file cannot be settled', async () => {
    vi.mocked(settleBrandBookFiles).mockRejectedValue(
      new BrandFileError('A file belongs to another brand book.'),
    );
    const response = await POST(post({ book }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      'another brand book',
    );
    expect(writeBrandBook).not.toHaveBeenCalled();
  });

  it('delegates a local admin’s new book to them, or rolls it back', async () => {
    serviceGetSnapshot.mockReturnValue({ config: localConfig });
    mockAuth.mockResolvedValue({
      user: { id: 'u5', mail: 'local@example.com' },
    });
    expect((await POST(post({ book }))).status).toBe(200);
    expect(delegateToCreator).toHaveBeenCalledTimes(1);

    vi.mocked(delegateToCreator).mockResolvedValue(false);
    const refused = await POST(post({ book }));
    expect(refused.status).toBe(503);
    expect(deleteBrandBook).toHaveBeenCalledTimes(1);
    expect(removeUnusedBrandBookFiles).toHaveBeenCalledWith(
      expect.stringMatching(/^brand-/),
      null,
    );
  });

  it('PUT needs a strong If-Match, keeps createdBy, writes with CAS and tidies files', async () => {
    vi.mocked(readBrandBook).mockResolvedValue({
      record: makeRecord(),
      etag: ETAG,
    });
    expect((await PUT(put({ id: ID, book }, null))).status).toBe(400);
    expect((await PUT(put({ id: ID, book }, 'W/"weak"'))).status).toBe(400);
    mockAuth.mockResolvedValue({
      user: { id: 'u3', mail: 'global@example.com' },
    });
    const response = await PUT(put({ id: ID, book: { ...book, name: 'NW' } }));
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data.record.createdBy).toBe('global@example.com');
    expect(body.data.record.book.name).toBe('NW');
    expect(vi.mocked(writeBrandBook).mock.calls[0][2]).toBe(ETAG);
    expect(removeUnusedBrandBookFiles).toHaveBeenCalledWith(
      ID,
      body.data.record.book,
    );
  });

  it('PUT 404s an unknown id and refuses a malformed one', async () => {
    vi.mocked(readBrandBook).mockResolvedValue(null);
    expect((await PUT(put({ id: ID, book }))).status).toBe(404);
    expect((await PUT(put({ id: 'nope', book }))).status).toBe(400);
  });

  it('lists only the books a local admin may edit, and refuses them others', async () => {
    const other = makeRecord({ id: 'brand-000000000001' });
    vi.mocked(listAllBrandBooks).mockResolvedValue([
      stored(makeRecord()),
      stored(other),
    ]);
    vi.mocked(readConfig).mockResolvedValue({
      config: localConfig,
      etag: '"cfg"',
    });
    serviceGetSnapshot.mockReturnValue({ config: localConfig });
    mockAuth.mockResolvedValue({
      user: { id: 'u5', mail: 'local@example.com' },
    });
    const body = await parseJsonResponse(await GET());
    expect(
      body.data.books.map((b: { record: { id: string } }) => b.record.id),
    ).toEqual([ID]);
    expect((await DELETE(remove(other.id))).status).toBe(403);
  });

  it('DELETE removes the record and all its files, with history', async () => {
    const response = await DELETE(remove(ID));
    expect(response.status).toBe(200);
    expect(deleteBrandBook).toHaveBeenCalledWith({}, ID, ETAG);
    expect(removeUnusedBrandBookFiles).toHaveBeenCalledWith(ID, null);
    expect(
      vi.mocked(writeBrandBookHistoryEntry).mock.calls[0][1],
    ).toMatchObject({ action: 'delete', record: null });
    vi.mocked(deleteBrandBook).mockResolvedValue(false);
    expect((await DELETE(remove(ID))).status).toBe(404);
  });
});
