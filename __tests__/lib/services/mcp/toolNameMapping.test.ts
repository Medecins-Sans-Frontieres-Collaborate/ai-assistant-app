import {
  fromModelToolName,
  mcpToolsToOpenAITools,
  toModelToolName,
} from '@/lib/services/mcp/toolNameMapping';

import { ResolvedMcpServer } from '@/config/mcpCatalog';
import { describe, expect, it } from 'vitest';

const server = (id: string): ResolvedMcpServer => ({
  id,
  label: id,
  url: 'https://mcp.example.com',
  transport: 'streamable-http',
  auth: { style: 'bearer' },
  trusted: false,
});

describe('toModelToolName', () => {
  it('joins serverId and tool name with a double underscore', () => {
    expect(toModelToolName('github', 'list_prs')).toBe('github__list_prs');
  });

  it('always matches the OpenAI function-name pattern', () => {
    const names = [
      toModelToolName('github', 'list_prs'),
      toModelToolName('asana', 'tasks.search'),
      toModelToolName('c1', 'weird tool!name'),
      toModelToolName('c1', 'x'.repeat(200)),
    ];
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('does not collide two names that sanitize identically', () => {
    expect(toModelToolName('s', 'a.b')).not.toBe(toModelToolName('s', 'a-b'));
    expect(toModelToolName('s', 'a.b')).not.toBe(toModelToolName('s', 'a b'));
  });

  it('caps overlong names at 64 chars while staying unique', () => {
    const a = toModelToolName('server', `${'x'.repeat(100)}A`);
    const b = toModelToolName('server', `${'x'.repeat(100)}B`);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });
});

describe('fromModelToolName', () => {
  it('round-trips through the known tool lists', () => {
    const serversWithTools = [
      {
        server: server('github'),
        tools: [
          { name: 'list_prs', inputSchema: {} },
          { name: 'tasks.search', inputSchema: {} },
        ],
      },
      {
        server: server('asana'),
        tools: [{ name: 'tasks.search', inputSchema: {} }],
      },
    ];

    const modelName = toModelToolName('asana', 'tasks.search');
    const resolved = fromModelToolName(modelName, serversWithTools);

    expect(resolved?.server.id).toBe('asana');
    expect(resolved?.toolName).toBe('tasks.search');
  });

  it('returns null for a tool name the model invented', () => {
    expect(
      fromModelToolName('github__made_up', [
        {
          server: server('github'),
          tools: [{ name: 'real', inputSchema: {} }],
        },
      ]),
    ).toBeNull();
  });
});

describe('mcpToolsToOpenAITools', () => {
  it('maps MCP tool definitions to chat.completions function tools', () => {
    const tools = mcpToolsToOpenAITools('github', [
      {
        name: 'list_prs',
        description: 'List pull requests',
        inputSchema: {
          type: 'object',
          properties: { repo: { type: 'string' } },
        },
      },
    ]);

    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'github__list_prs',
          description: 'List pull requests',
          parameters: {
            type: 'object',
            properties: { repo: { type: 'string' } },
          },
        },
      },
    ]);
  });
});
