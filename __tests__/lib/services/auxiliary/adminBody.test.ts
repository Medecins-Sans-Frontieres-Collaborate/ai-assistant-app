import { readAuxiliaryAdminBody } from '@/lib/services/auxiliary/adminBody';

import { describe, expect, it } from 'vitest';

describe('bounded auxiliary admin bodies', () => {
  it('parses JSON without accepting cross-origin simple text/plain requests', async () => {
    expect(
      await readAuxiliaryAdminBody(
        new Request('https://app.example', {
          method: 'POST',
          body: '{"purpose":"routing"}',
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).toEqual({ purpose: 'routing' });
    await expect(
      readAuxiliaryAdminBody(
        new Request('https://app.example', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    ).rejects.toThrow('application/json');
  });
  it('refuses more than 32 KB regardless of declared Content-Length', async () => {
    await expect(
      readAuxiliaryAdminBody(
        new Request('https://app.example', {
          method: 'POST',
          body: JSON.stringify({ text: 'x'.repeat(33000) }),
          headers: {
            'content-type': 'application/json',
            'content-length': '2',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
