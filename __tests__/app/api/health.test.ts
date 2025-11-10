import { GET } from '@/app/api/health/route';
import { describe, expect, it } from 'vitest';

describe('GET /api/health', () => {
  it('returns 200 OK status', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it('returns OK text', async () => {
    const response = await GET();
    const text = await response.text();
    expect(text).toBe('OK');
  });

  it('has correct content type', async () => {
    const response = await GET();
    expect(response.headers.get('content-type')).toContain('text/plain');
  });
});
