import { withOauthErrorNormalization } from '@/lib/services/mcp/oauthResponseNormalization';

import { describe, expect, it, vi } from 'vitest';

/**
 * GitHub reports token-endpoint failures as HTTP 200 with an `error` field
 * — the wrapper must convert those to 400 so the SDK's OAuth error parser
 * surfaces the real reason, while leaving genuine successes byte-identical.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

describe('withOauthErrorNormalization', () => {
  it('rewrites a 200-with-error body to HTTP 400, body preserved', async () => {
    const inner = vi.fn(async () =>
      jsonResponse({
        error: 'redirect_uri_mismatch',
        error_description:
          'The redirect_uri MUST match the registered callback URL for this application.',
      }),
    );

    const response = await withOauthErrorNormalization(inner)(
      'https://github.com/login/oauth/access_token',
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('redirect_uri_mismatch');
  });

  it('passes a genuine token response through unchanged', async () => {
    const inner = vi.fn(async () =>
      jsonResponse({ access_token: 'at', token_type: 'bearer' }),
    );

    const response = await withOauthErrorNormalization(inner)(
      'https://github.com/login/oauth/access_token',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: 'at',
      token_type: 'bearer',
    });
  });

  it('leaves real non-2xx errors alone', async () => {
    const inner = vi.fn(async () =>
      jsonResponse({ error: 'invalid_client' }, 401),
    );

    const response = await withOauthErrorNormalization(inner)(
      'https://auth.example.com/token',
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('invalid_client');
  });

  it('leaves non-JSON responses untouched (body unconsumed)', async () => {
    const original = new Response('access_token=at&token_type=bearer', {
      status: 200,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const inner = vi.fn(async () => original);

    const response = await withOauthErrorNormalization(inner)(
      'https://auth.example.com/token',
    );

    // Same object — the wrapper must not have consumed its stream.
    expect(response).toBe(original);
    expect(await response.text()).toBe('access_token=at&token_type=bearer');
  });

  it('tolerates a 200 JSON content-type with a malformed body', async () => {
    const inner = vi.fn(
      async () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const response = await withOauthErrorNormalization(inner)(
      'https://auth.example.com/token',
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('not json');
  });
});
