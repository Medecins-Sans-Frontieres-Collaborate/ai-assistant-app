import {
  assertPublicHost,
  guardedFetch,
  isHttpsPublicShapedUrl,
} from '@/lib/services/mcp/mcpUrlGuard';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

beforeEach(() => {
  mockLookup.mockReset();
});

describe('isHttpsPublicShapedUrl', () => {
  it.each([
    'https://mcp.example.com/path',
    'https://api.githubcopilot.com/mcp/',
    'https://mcp.asana.com/sse',
  ])('accepts public https URL %s', (url) => {
    expect(isHttpsPublicShapedUrl(url)).toBe(true);
  });

  it.each([
    ['http', 'http://mcp.example.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['not a URL', 'not a url'],
    // Deliberate fake credential: this fixture exists to prove the SSRF
    // guard REJECTS userinfo URLs. Nothing real.
    // secretlint-disable-next-line
    ['userinfo', 'https://user:pass@mcp.example.com'],
    ['localhost', 'https://localhost/mcp'],
    ['sub.localhost', 'https://foo.localhost/mcp'],
    ['.local', 'https://printer.local/mcp'],
    ['.internal', 'https://svc.internal/mcp'],
    ['loopback v4', 'https://127.0.0.1/mcp'],
    ['private 10/8', 'https://10.0.0.1/mcp'],
    ['private 172.16/12', 'https://172.20.1.1/mcp'],
    ['private 192.168/16', 'https://192.168.1.1/mcp'],
    ['link-local', 'https://169.254.169.254/latest/meta-data'],
    ['CGNAT', 'https://100.64.0.1/mcp'],
    ['0.0.0.0', 'https://0.0.0.0/mcp'],
    ['v6 loopback', 'https://[::1]/mcp'],
    ['v6 link-local', 'https://[fe80::1]/mcp'],
    ['v6 ULA', 'https://[fd12:3456::1]/mcp'],
    ['v4-mapped v6 private', 'https://[::ffff:192.168.0.1]/mcp'],
  ])('rejects %s', (_label, url) => {
    expect(isHttpsPublicShapedUrl(url)).toBe(false);
  });

  it('rejects URLs longer than 2048 chars', () => {
    expect(
      isHttpsPublicShapedUrl(`https://mcp.example.com/${'a'.repeat(2100)}`),
    ).toBe(false);
  });
});

describe('assertPublicHost', () => {
  it('passes when all resolved addresses are public', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
    await expect(
      assertPublicHost('https://mcp.example.com'),
    ).resolves.toBeUndefined();
  });

  it('rejects when ANY resolved address is private (DNS rebinding)', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(
      assertPublicHost('https://rebind.example.com'),
    ).rejects.toThrow(/non-public/);
  });

  it('rejects when the host does not resolve', async () => {
    mockLookup.mockResolvedValue([]);
    await expect(assertPublicHost('https://ghost.example.com')).rejects.toThrow(
      /did not resolve/,
    );
  });

  it('skips DNS for IP-literal hosts and validates directly', async () => {
    await expect(
      assertPublicHost('https://8.8.8.8/mcp'),
    ).resolves.toBeUndefined();
    await expect(assertPublicHost('https://10.1.1.1/mcp')).rejects.toThrow();
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe('guardedFetch', () => {
  it('re-validates every request URL and blocks private ones', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('ok'));
    const fetchImpl = guardedFetch(inner);

    await expect(fetchImpl('https://192.168.0.1/steal')).rejects.toThrow(
      /Blocked/,
    );
    expect(inner).not.toHaveBeenCalled();
  });

  it('forwards allowed requests with redirect: error', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const inner = vi.fn().mockResolvedValue(new Response('ok'));
    const fetchImpl = guardedFetch(inner);

    await fetchImpl('https://mcp.example.com/rpc', { method: 'POST' });

    expect(inner).toHaveBeenCalledWith(
      'https://mcp.example.com/rpc',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
  });
});
