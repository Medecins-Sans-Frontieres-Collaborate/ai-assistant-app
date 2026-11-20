import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  listAllBrandBooks,
  readBrandBook,
} from '@/lib/services/agentAccess/accessRulesStore';
import { downloadBlob } from '@/lib/services/agentAccess/blobCas';
import {
  AdminBrandBook,
  BRAND_BOOK_SOURCE,
  brandBookBlobPath,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';

import { GET as GET_FILE } from '@/app/api/brand-books/[id]/files/[name]/route';
import { GET as GET_ONE } from '@/app/api/brand-books/[id]/route';
import { GET as GET_LIST } from '@/app/api/brand-books/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The person's side of brand books: the books their access rules allow,
 * one book, and its files, with one 404 for whatever they may not see.
 */

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEvaluateAccess = vi.hoisted(() => vi.fn());

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: vi.fn(),
      evaluateAccess: serviceEvaluateAccess,
    }),
  },
}));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn(async () => []),
}));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));
vi.mock('@/lib/services/agentAccess/blobCas', () => ({
  downloadBlob: vi.fn(),
}));
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createAgentAccessBlobStorage: vi.fn(),
    listAllBrandBooks: vi.fn(),
    readBrandBook: vi.fn(),
  }),
);

const ALLOWED = 'brand-aaaaaaaaaaaa';
const DENIED = 'brand-bbbbbbbbbbbb';
const LOGO = `${'d'.repeat(32)}.svg`;

function record(id: string, name: string): AdminBrandBook {
  const parsed = parseBrandBookBody({
    name,
    palette: [{ name: 'Teal', hex: '#0f7c80' }],
    logos: [{ id: 'main', name: 'Logo', file: `admin:${id}/${LOGO}` }],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    version: 1,
    id,
    book: parsed.body,
    createdBy: 'admin@example.com',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedBy: 'admin@example.com',
    updatedAt: '2026-11-02T00:00:00.000Z',
  };
}

const books = new Map([
  [ALLOWED, record(ALLOWED, 'Northwind')],
  [DENIED, record(DENIED, 'Secret')],
]);

const request = (path: string) =>
  new NextRequest(`https://app.example.com${path}`);

describe('/api/brand-books', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceIsEnabled.mockReturnValue(true);
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'user@example.com' },
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    serviceEvaluateAccess.mockImplementation(
      ({ source, agentName }: { source: string; agentName: string }) => ({
        decision:
          source === BRAND_BOOK_SOURCE && agentName === ALLOWED
            ? 'allow'
            : 'deny',
      }),
    );
    vi.mocked(listAllBrandBooks).mockResolvedValue(
      [...books.values()].map((r) => ({
        canonicalKey: canonicalAgentKey(BRAND_BOOK_SOURCE, r.id),
        blobPath: brandBookBlobPath(r.id),
        record: r,
        etag: '"e"',
      })),
    );
    vi.mocked(readBrandBook).mockImplementation(async (_s, id) => {
      const found = books.get(id);
      return found ? { record: found, etag: '"e"' } : null;
    });
    vi.mocked(downloadBlob).mockResolvedValue({
      buffer: Buffer.from('<svg/>'),
      etag: '"f"',
    });
  });

  it('lists only the books the person may use', async () => {
    const response = await GET_LIST(request('/api/brand-books'));
    const body = await response.json();
    expect(body.data.books).toEqual([
      expect.objectContaining({
        id: ALLOWED,
        name: 'Northwind',
        colors: ['#0f7c80'],
      }),
    ]);
  });

  it('lists nothing, not an error, while agent access is off', async () => {
    serviceIsEnabled.mockReturnValue(false);
    const body = await (await GET_LIST(request('/api/brand-books'))).json();
    expect(body.data.books).toEqual([]);
  });

  it('needs a signed-in person', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET_LIST(request('/api/brand-books'))).status).toBe(401);
  });

  it('gives a usable book whole, and one 404 for denied, missing or malformed', async () => {
    const ok = await GET_ONE(request(`/api/brand-books/${ALLOWED}`), {
      params: Promise.resolve({ id: ALLOWED }),
    });
    expect((await ok.json()).data.book.name).toBe('Northwind');
    for (const id of [DENIED, 'brand-cccccccccccc', '../x']) {
      const refused = await GET_ONE(request(`/api/brand-books/${id}`), {
        params: Promise.resolve({ id }),
      });
      expect(refused.status).toBe(404);
    }
  });

  it('serves a referenced file of a usable book, sandboxed and never sniffed', async () => {
    const response = await GET_FILE(request('/x'), {
      params: Promise.resolve({ id: ALLOWED, name: LOGO }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      'sandbox',
    );
  });

  it.each([
    ['a book the person may not use', DENIED, LOGO],
    ['a file the book does not reference', ALLOWED, `${'e'.repeat(32)}.svg`],
    ['a name of another shape', ALLOWED, '../../config.json'],
  ])('answers 404 for %s', async (_label, id, name) => {
    const response = await GET_FILE(request('/x'), {
      params: Promise.resolve({ id, name }),
    });
    expect(response.status).toBe(404);
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
