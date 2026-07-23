import { planMcpSteps } from '@/lib/services/mcp/McpPlannerService';
import { ServerWithTools } from '@/lib/services/mcp/toolLoopCore';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const serversWithTools = [
  {
    server: { id: 'github', label: 'GitHub', trusted: true },
    tools: [
      { name: 'get_me', description: 'Get the authenticated user' },
      { name: 'search_pull_requests', description: 'Search PRs' },
    ],
  },
] as unknown as ServerWithTools[];

function clientReturning(content: string | null) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  } as any;
}

describe('planMcpSteps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns validated steps with hallucinated tool names dropped', async () => {
    const client = clientReturning(
      JSON.stringify({
        steps: [
          { description: 'Identify the user', tools: ['get_me'] },
          {
            description: 'Find PRs to review',
            tools: ['search_pull_requests', 'made_up_tool'],
          },
        ],
      }),
    );

    const steps = await planMcpSteps(
      client,
      'find my review PRs',
      serversWithTools,
    );

    expect(steps).toEqual([
      { description: 'Identify the user', tools: ['get_me'] },
      { description: 'Find PRs to review', tools: ['search_pull_requests'] },
    ]);
    // Planner runs on the small model with structured output
    const params = client.chat.completions.create.mock.calls[0][0];
    expect(params.model).toBe('gpt-5-mini');
    expect(params.response_format.type).toBe('json_schema');
  });

  it('returns null on planner failure (loop runs plan-less)', async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('capacity')),
        },
      },
    } as any;

    expect(await planMcpSteps(client, 'anything', serversWithTools)).toBeNull();
  });

  it('returns null on malformed output', async () => {
    const client = clientReturning('not json at all');
    expect(await planMcpSteps(client, 'anything', serversWithTools)).toBeNull();
  });

  it('returns null when no server has tools', async () => {
    const client = clientReturning('{}');
    const empty = [
      { server: { id: 's', label: 'S', trusted: true }, tools: [] },
    ] as unknown as ServerWithTools[];

    expect(await planMcpSteps(client, 'anything', empty)).toBeNull();
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });
});
