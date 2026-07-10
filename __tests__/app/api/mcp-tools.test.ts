import { clearToolSchemaCache } from '@/lib/services/mcp/toolSchemaCache';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/mcp/tools/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockConnectMcp = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  MCP_CUSTOM_SERVERS_ENABLED: false,
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/mcp/McpClientService', () => ({
  connectMcp: mockConnectMcp,
}));
vi.mock('@/config/environment', () => ({ env: mockEnv }));

const githubBody = {
  server: {
    id: 'gh1',
    name: 'GitHub',
    catalogKey: 'github',
    authToken: 'github_pat_test',
  },
};

function mockConnection(tools: Array<{ name: string; description?: string }>) {
  return {
    listTools: vi
      .fn()
      .mockResolvedValue(
        tools.map((t) => ({ ...t, inputSchema: { type: 'object' } })),
      ),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('POST /api/mcp/tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearToolSchemaCache();
    mockEnv.MCP_CUSTOM_SERVERS_ENABLED = false;
    mockAuth.mockResolvedValue(createMockSession());
  });

  it('returns 401 without a session', async () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST(
      createMockRequest({ method: 'POST', body: githubBody }),
    );

    expect(res.status).toBe(401);
  });

  it('lists tools for a curated server and never echoes the token', async () => {
    const connection = mockConnection([
      { name: 'list_prs', description: 'List pull requests' },
      { name: 'create_issue' },
    ]);
    mockConnectMcp.mockResolvedValue(connection);

    const res = await POST(
      createMockRequest({ method: 'POST', body: githubBody }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(200);
    expect(json.data.serverLabel).toBe('GitHub');
    expect(json.data.tools).toHaveLength(2);
    expect(JSON.stringify(json)).not.toContain('github_pat_test');
    expect(connection.close).toHaveBeenCalled();

    // Resolution came from the catalog, not from anything client-sent.
    const resolved = mockConnectMcp.mock.calls[0][0];
    expect(resolved.url).toBe('https://api.githubcopilot.com/mcp/');
    expect(resolved.trusted).toBe(true);
  });

  it('serves the second identical request from cache without reconnecting', async () => {
    mockConnectMcp.mockResolvedValue(mockConnection([{ name: 'a' }]));

    await POST(createMockRequest({ method: 'POST', body: githubBody }));
    const res = await POST(
      createMockRequest({ method: 'POST', body: githubBody }),
    );
    const json = await parseJsonResponse(res);

    expect(mockConnectMcp).toHaveBeenCalledTimes(1);
    expect(json.data.cached).toBe(true);
  });

  it('refresh=true bypasses the cache', async () => {
    mockConnectMcp.mockResolvedValue(mockConnection([{ name: 'a' }]));

    await POST(createMockRequest({ method: 'POST', body: githubBody }));
    await POST(
      createMockRequest({
        method: 'POST',
        body: { ...githubBody, refresh: true },
      }),
    );

    expect(mockConnectMcp).toHaveBeenCalledTimes(2);
  });

  it('returns 403 for custom URLs when the env gate is off', async () => {
    const res = await POST(
      createMockRequest({
        method: 'POST',
        body: {
          server: { id: 'c1', name: 'Mine', url: 'https://mcp.example.com' },
        },
      }),
    );

    expect(res.status).toBe(403);
    expect(mockConnectMcp).not.toHaveBeenCalled();
  });

  it('rejects private custom URLs even when the env gate is on', async () => {
    mockEnv.MCP_CUSTOM_SERVERS_ENABLED = true;

    const res = await POST(
      createMockRequest({
        method: 'POST',
        body: {
          server: { id: 'c1', name: 'Mine', url: 'https://192.168.0.1/mcp' },
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(mockConnectMcp).not.toHaveBeenCalled();
  });

  it('maps auth failures to MCP_AUTH_FAILED', async () => {
    mockConnectMcp.mockRejectedValue(
      new Error('MCP server "GitHub" unreachable (HTTP 401)'),
    );

    const res = await POST(
      createMockRequest({ method: 'POST', body: githubBody }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(502);
    expect(json.code).toBe('MCP_AUTH_FAILED');
  });

  it('rejects malformed bodies with 400', async () => {
    const res = await POST(
      createMockRequest({
        method: 'POST',
        body: { server: { id: 'bad id!', name: '' } },
      }),
    );

    expect(res.status).toBe(400);
  });
});
