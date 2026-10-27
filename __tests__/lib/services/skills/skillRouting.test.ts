import { ToolRouterService } from '@/lib/services/chat/ToolRouterService';
import { selectedSkillIds } from '@/lib/services/skills/skillRouting';
import { SKILL_LIMITS } from '@/lib/services/skills/types';

import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

const skillCatalog = [
  {
    id: 'gdpr',
    name: 'GDPR Guidance',
    description: 'Data protection questions.',
  },
  {
    id: 'platform-help',
    name: 'Platform Help',
    description: 'Questions about this app.',
  },
];
function harness(content: unknown) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(content) } }],
  });
  return {
    create,
    router: new ToolRouterService({
      chat: { completions: { create } },
    } as unknown as OpenAI),
  };
}

describe('skill routing contracts', () => {
  it('piggybacks on one tool decision, even when no web/code tools are selected', async () => {
    const { create, router } = harness({
      needsWebSearch: false,
      relevantSkills: ['gdpr'],
    });
    const result = await router.determineTool({
      messages: [],
      currentMessage: 'Privacy?',
      skillCatalog,
    });
    expect(result.tools).toEqual([]);
    expect(result.relevantSkills).toEqual(['gdpr']);
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0];
    expect(
      params.response_format.json_schema.schema.properties.relevantSkills.items
        .enum,
    ).toEqual(['gdpr', 'platform-help']);
    expect(options).toMatchObject({
      timeout: SKILL_LIMITS.routingTimeoutMs,
      maxRetries: 0,
    });
    expect(params.messages[0].content).toContain('Honor an explicit request');
  });

  it('skills-only routing has no web/code schema and always includes the current message', async () => {
    const { create, router } = harness({
      relevantSkills: ['gdpr', 'unknown', 'gdpr'],
    });
    const result = await router.determineSkills({
      messages: [],
      currentMessage: 'Use GDPR',
      skillCatalog,
    });
    expect(result.relevantSkills).toEqual(['gdpr']);
    const params = create.mock.calls[0][0];
    expect(
      Object.keys(params.response_format.json_schema.schema.properties),
    ).toEqual(['relevantSkills']);
    expect(params.messages.at(-1).content).toBe('Use GDPR');
  });

  it('does not call the provider for an empty catalog', async () => {
    const { create, router } = harness({});
    expect(
      await router.determineSkills({
        messages: [],
        currentMessage: 'Hi',
        skillCatalog: [],
      }),
    ).toEqual({ relevantSkills: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['failure', 'malformed', 'missing'])(
    'fails boundedly on %s',
    async (mode) => {
      const { create, router } = harness({});
      if (mode === 'failure') create.mockRejectedValue(new Error('timeout'));
      if (mode === 'malformed')
        create.mockResolvedValue({ choices: [{ message: { content: '{' } }] });
      expect(
        await router.determineSkills({
          messages: [],
          currentMessage: 'Help',
          skillCatalog,
        }),
      ).toEqual({ relevantSkills: [], degraded: true });
    },
  );

  it('revalidates ids and caps parallel choices independently of model compliance', () => {
    const catalog = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      name: id,
      description: id,
    }));
    expect(selectedSkillIds(['bad', 'a', 'a', 'b', 'c', 'd'], catalog)).toEqual(
      ['a', 'b', 'c'],
    );
  });
});
