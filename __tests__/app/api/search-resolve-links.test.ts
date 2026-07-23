import { NextRequest } from 'next/server';

import { POST } from '@/app/api/search/resolve-links/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/services/chat/tools/googleNewsSearch', () => ({
  resolveLinksSerially: vi.fn(async (links: string[]) =>
    links.map((link) =>
      link.includes('RESOLVABLE') ? 'https://publisher.example/story' : link,
    ),
  ),
}));

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/search/resolve-links', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const GOOGLE_LINK = 'https://news.google.com/rss/articles/CBMiRESOLVABLE123';
const GOOGLE_LINK_STUCK = 'https://news.google.com/rss/articles/CBMiSTUCK456';

describe('POST /api/search/resolve-links', () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: 'u1' } } as any);
  });

  it('requires authentication', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const response = await POST(makeRequest({ links: [GOOGLE_LINK] }));
    expect(response.status).toBe(401);
  });

  it('resolves google links and reports only actual upgrades', async () => {
    const response = await POST(
      makeRequest({ links: [GOOGLE_LINK, GOOGLE_LINK_STUCK] }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.resolved).toEqual({
      [GOOGLE_LINK]: 'https://publisher.example/story',
    });
  });

  it('rejects non-google links (not a general URL proxy)', async () => {
    const response = await POST(
      makeRequest({ links: ['https://internal.service/admin'] }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects oversized batches and malformed bodies', async () => {
    const tooMany = Array.from(
      { length: 16 },
      (_, i) => `https://news.google.com/rss/articles/CBMi${i}`,
    );
    expect((await POST(makeRequest({ links: tooMany }))).status).toBe(400);
    expect((await POST(makeRequest({ links: [] }))).status).toBe(400);
    expect((await POST(makeRequest({ nope: true }))).status).toBe(400);
  });
});
