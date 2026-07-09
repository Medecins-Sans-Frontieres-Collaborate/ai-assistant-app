// @vitest-environment jsdom
import {
  connectMcpOauth,
  ensureFreshOauthToken,
} from '@/client/services/mcp/mcpOauth';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockStartAuthorization = vi.hoisted(() => vi.fn());
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  startAuthorization: mockStartAuthorization,
}));

function mockFetchRoutes(
  routes: Record<string, (body: any) => { status?: number; json: unknown }>,
) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const handler = routes[url];
    if (!handler) throw new Error(`Unexpected fetch: ${url}`);
    const result = handler(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

const asanaEntry = { id: 'asana', name: 'Asana', catalogKey: 'asana' };

const oauthServer = {
  id: 'asana',
  catalogKey: 'asana',
  name: 'Asana',
  url: '',
  authMode: 'oauth' as const,
  enabled: true,
  createdAt: 'now',
  oauth: {
    accessToken: 'at-old',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 30_000, // within the 60s refresh skew
    clientId: 'dcr-1',
  },
};

describe('connectMcpOauth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    mockStartAuthorization.mockResolvedValue({
      authorizationUrl: new URL('https://auth.asana.example/authorize?x=1'),
      codeVerifier: 'verifier-abc',
    });
  });

  it('happy path: discover → register → popup → exchange → tokens', async () => {
    globalThis.fetch = mockFetchRoutes({
      '/api/mcp/oauth/discover': () => ({
        json: {
          success: true,
          data: {
            authorizationEndpoint: 'https://auth.asana.example/authorize',
            scopesSupported: [],
            resource: null,
            registrationSupported: true,
          },
        },
      }),
      '/api/mcp/oauth/register': () => ({
        json: { success: true, data: { clientId: 'dcr-1' } },
      }),
      '/api/mcp/oauth/token': (body) => {
        expect(body.grant).toMatchObject({
          type: 'authorization_code',
          code: 'code-xyz',
          codeVerifier: 'verifier-abc',
          clientId: 'dcr-1',
        });
        return {
          json: {
            success: true,
            data: {
              tokens: {
                access_token: 'at-new',
                refresh_token: 'rt-new',
                expires_in: 3600,
              },
            },
          },
        };
      },
    }) as never;
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue({ closed: false } as Window);

    const promise = connectMcpOauth(asanaEntry);

    // Simulate the callback page posting back (after the flow stashes state).
    await vi.waitFor(() => {
      expect(openSpy).toHaveBeenCalled();
    });
    const stashKey = Object.keys(sessionStorage).find((k) =>
      k.startsWith('mcp-oauth:'),
    )!;
    const state = stashKey.slice('mcp-oauth:'.length);
    new BroadcastChannel('mcp-oauth').postMessage({ state, code: 'code-xyz' });

    const result = await promise;

    expect(result.accessToken).toBe('at-new');
    expect(result.refreshToken).toBe('rt-new');
    expect(result.clientId).toBe('dcr-1');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    // Verifier stash is cleaned up.
    expect(sessionStorage.getItem(stashKey)).toBeNull();
  });

  it('skips registration entirely when the user supplies their OWN app clientId', async () => {
    const fetchSpy = mockFetchRoutes({
      '/api/mcp/oauth/discover': () => ({
        json: {
          success: true,
          data: {
            authorizationEndpoint: 'https://auth.asana.example/authorize',
            scopesSupported: [],
            resource: null,
            registrationSupported: false,
          },
        },
      }),
      '/api/mcp/oauth/token': (body) => {
        expect(body.grant.clientId).toBe('my-own-app');
        expect(body.grant.clientSecret).toBe('my-own-secret');
        return {
          json: {
            success: true,
            data: { tokens: { access_token: 'at', expires_in: 60 } },
          },
        };
      },
    });
    globalThis.fetch = fetchSpy as never;
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue({ closed: false } as Window);

    const promise = connectMcpOauth(asanaEntry, 'my-own-app', 'my-own-secret');
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalled());
    const stashKey = Object.keys(sessionStorage).find((k) =>
      k.startsWith('mcp-oauth:'),
    )!;
    const state = stashKey.slice('mcp-oauth:'.length);
    new BroadcastChannel('mcp-oauth').postMessage({ state, code: 'c' });

    const result = await promise;

    expect(result.clientId).toBe('my-own-app');
    expect(result.clientSecret).toBe('my-own-secret');
    // /register was never called (no route for it => would have thrown).
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).not.toContain('/api/mcp/oauth/register');
  });

  it('ignores messages with a mismatched state and fails on denial', async () => {
    globalThis.fetch = mockFetchRoutes({
      '/api/mcp/oauth/discover': () => ({
        json: {
          success: true,
          data: {
            authorizationEndpoint: 'https://auth.asana.example/authorize',
            scopesSupported: [],
            resource: null,
            registrationSupported: true,
          },
        },
      }),
      '/api/mcp/oauth/register': () => ({
        json: { success: true, data: { clientId: 'dcr-1' } },
      }),
    }) as never;
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue({ closed: false } as Window);

    const promise = connectMcpOauth(asanaEntry);
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalled());
    const stashKey = Object.keys(sessionStorage).find((k) =>
      k.startsWith('mcp-oauth:'),
    )!;
    const state = stashKey.slice('mcp-oauth:'.length);

    const channel = new BroadcastChannel('mcp-oauth');
    // Wrong state: must be ignored…
    channel.postMessage({ state: 'someone-elses-state', code: 'evil' });
    // …then the real denial arrives.
    channel.postMessage({ state, error: 'access_denied' });

    await expect(promise).rejects.toThrow('oauth_denied');
  });
});

describe('ensureFreshOauthToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({ mcpServers: [oauthServer] });
  });

  it('returns the current token when not near expiry', async () => {
    const fresh = {
      ...oauthServer,
      oauth: { ...oauthServer.oauth, expiresAt: Date.now() + 3_600_000 },
    };
    const token = await ensureFreshOauthToken(fresh);
    expect(token).toBe('at-old');
  });

  it('single-flight: two concurrent refreshes make ONE network call', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            tokens: {
              access_token: 'at-2',
              refresh_token: 'rt-2',
              expires_in: 3600,
            },
          },
        }),
        { status: 200 },
      );
    }) as never;

    const [a, b] = await Promise.all([
      ensureFreshOauthToken(oauthServer),
      ensureFreshOauthToken(oauthServer),
    ]);

    expect(a).toBe('at-2');
    expect(b).toBe('at-2');
    expect(calls).toBe(1);
    // Rotated refresh token adopted in the store.
    const stored = useSettingsStore.getState().mcpServers[0];
    expect(stored.oauth?.refreshToken).toBe('rt-2');
  });

  it('invalid_grant wipes tokens, keeps the clientId, and flags needsReauth', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'The authorization is no longer valid',
            code: 'OAUTH_INVALID_GRANT',
          }),
          { status: 400 },
        ),
    ) as never;

    const token = await ensureFreshOauthToken(oauthServer);

    expect(token).toBeUndefined();
    const stored = useSettingsStore.getState().mcpServers[0];
    expect(stored.oauth?.accessToken).toBeUndefined();
    expect(stored.oauth?.refreshToken).toBeUndefined();
    expect(stored.oauth?.clientId).toBe('dcr-1');
    expect(stored.oauth?.needsReauth).toBe(true);
  });

  it('returns undefined for needsReauth servers without a network call', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;

    const token = await ensureFreshOauthToken({
      ...oauthServer,
      oauth: { clientId: 'dcr-1', needsReauth: true },
    });

    expect(token).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
