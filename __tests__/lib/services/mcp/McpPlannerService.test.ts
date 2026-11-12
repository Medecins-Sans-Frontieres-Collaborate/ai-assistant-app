/**
 * MCP turn planning: validated steps from the residency-routed auxiliary
 * chain (a fake one here), the chat-model fallback, and null on any failure
 * so the tool loop runs plan-less.
 */
import { planMcpSteps } from '@/lib/services/mcp/McpPlannerService';
import { ServerWithTools } from '@/lib/services/mcp/toolLoopCore';

import {
  installFakeAuxiliaryCompletions,
  jsonReply,
} from '../auxiliary/fakeCompletions';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serversWithTools = [
  {
    server: { id: 'github', label: 'GitHub', trusted: true },
    tools: [
      { name: 'get_me', description: 'Get the authenticated user' },
      { name: 'search_pull_requests', description: 'Search PRs' },
    ],
  },
] as unknown as ServerWithTools[];

const validPlan = {
  steps: [
    { description: 'Identify the user', tools: ['get_me'] },
    {
      description: 'Find PRs to review',
      tools: ['search_pull_requests', 'made_up_tool'],
    },
  ],
};

let fake: ReturnType<typeof installFakeAuxiliaryCompletions>;

describe('planMcpSteps', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake = installFakeAuxiliaryCompletions();
  });
  afterEach(() => {
    fake.restore();
    vi.restoreAllMocks();
  });

  it('returns validated steps with hallucinated tool names dropped', async () => {
    fake.create.mockResolvedValue(jsonReply(validPlan));

    const steps = await planMcpSteps('find my review PRs', serversWithTools, {
      region: 'EU',
    });

    expect(steps).toEqual([
      { description: 'Identify the user', tools: ['get_me'] },
      { description: 'Find PRs to review', tools: ['search_pull_requests'] },
    ]);
    // Structured output, no hardcoded model, in the routed region.
    const params = fake.create.mock.calls[0][0];
    expect(params.model).toBe('');
    expect(params.response_format.type).toBe('json_schema');
    expect(fake.regions).toEqual(['EU']);
  });

  it('plans in the US chain for a US user', async () => {
    fake.create.mockResolvedValue(jsonReply(validPlan));
    await planMcpSteps('find my review PRs', serversWithTools, {
      region: 'US',
    });
    expect(fake.regions).toEqual(['US']);
  });

  it("falls back to the user's chat model when the chain fails", async () => {
    fake.create.mockRejectedValue(new Error('no eligible model'));
    const fallback = vi.fn(async () => ({
      text: JSON.stringify(validPlan),
      model: { id: 'mistral-large' } as never,
      region: 'EU' as const,
    }));

    const steps = await planMcpSteps('find my review PRs', serversWithTools, {
      region: 'EU',
      fallback,
    });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(steps?.map((step) => step.description)).toEqual([
      'Identify the user',
      'Find PRs to review',
    ]);
  });

  it('returns null on planner failure (loop runs plan-less)', async () => {
    fake.create.mockRejectedValue(new Error('capacity'));
    expect(
      await planMcpSteps('anything', serversWithTools, { region: 'EU' }),
    ).toBeNull();
  });

  it('returns null on malformed output', async () => {
    fake.create.mockResolvedValue({
      choices: [{ message: { content: 'not json at all' } }],
    });
    expect(
      await planMcpSteps('anything', serversWithTools, { region: 'EU' }),
    ).toBeNull();
  });

  it('returns null when no server has tools', async () => {
    const empty = [
      { server: { id: 's', label: 'S', trusted: true }, tools: [] },
    ] as unknown as ServerWithTools[];

    expect(await planMcpSteps('anything', empty, { region: 'EU' })).toBeNull();
    expect(fake.create).not.toHaveBeenCalled();
  });
});
