import { NextRequest } from 'next/server';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('GET /api/version', () => {
  const originalEnv = process.env.NEXT_PUBLIC_BUILD;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_BUILD = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_BUILD;
    }
  });

  it('returns the build number from environment', async () => {
    process.env.NEXT_PUBLIC_BUILD = '42';

    const { GET } = await import('@/app/api/version/route');
    const request = new NextRequest(
      new URL('/api/version', 'http://localhost:3000'),
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ build: '42' });
  });

  it('returns "unknown" when NEXT_PUBLIC_BUILD is not set', async () => {
    delete process.env.NEXT_PUBLIC_BUILD;

    const { GET } = await import('@/app/api/version/route');
    const request = new NextRequest(
      new URL('/api/version', 'http://localhost:3000'),
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ build: 'unknown' });
  });

  it('sets no-store cache control header', async () => {
    process.env.NEXT_PUBLIC_BUILD = '99';

    const { GET } = await import('@/app/api/version/route');
    const request = new NextRequest(
      new URL('/api/version', 'http://localhost:3000'),
    );
    const response = await GET(request);

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
