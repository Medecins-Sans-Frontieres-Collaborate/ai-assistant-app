/**
 * Issue #149 audit harness: real regional routing and skill delivery, with
 * only provider I/O and catalog storage mocked. Passing cases characterize
 * current outage behavior; they do not prove production provisioning works.
 */
import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import {
  AUXILIARY_ROUTER_MODEL,
  ToolRouterService,
} from '@/lib/services/chat/ToolRouterService';
import { SkillEnricher } from '@/lib/services/chat/enrichers/SkillEnricher';
import { getVisibleSkills } from '@/lib/services/skills/skillCatalog';
import type { CatalogSkill } from '@/lib/services/skills/types';

import type { OpenAI } from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/skills/skillCatalog', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/services/skills/skillCatalog')
  >()),
  getVisibleSkills: vi.fn(),
}));

const catalog: CatalogSkill[] = [
  {
    builtin: false,
    overridden: false,
    skill: {
      version: 1,
      id: 'gdpr',
      name: 'GDPR Guidance',
      description: 'Handling data protection requests',
      activation: 'auto',
      applyToAgents: false,
      instructions: 'Follow the approved data protection workflow.',
      documents: [],
      updatedAt: '2026-10-24T00:00:00.000Z',
    },
  },
];

function provider(create: ReturnType<typeof vi.fn>): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function selection() {
  return {
    choices: [{ message: { content: '{"relevantSkills":["gdpr"]}' } }],
  };
}

function context() {
  const base = createTestChatContext({
    stream: false,
    systemPrompt: 'Core safety',
  });
  return {
    ...base,
    // The shared factory currently ignores options.user; set the actual context.
    user: { ...base.user, region: 'EU' as const },
    emitMarker: vi.fn().mockResolvedValue(undefined),
  };
}

describe('issue #149: EU automatic skill selection outage', () => {
  beforeEach(() => {
    vi.mocked(getVisibleSkills).mockResolvedValue(catalog);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    [404, 'DeploymentNotFound', 'deployment_missing'],
    [401, 'PermissionDenied', 'unauthorized'],
    [400, 'Unsupported reasoning_effort', 'provider'],
  ])(
    'turns EU provider HTTP %s into the reported warning on repeated turns',
    async (status, message, reason) => {
      const defaultCreate = vi.fn().mockResolvedValue(selection());
      const euCreate = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error(message), { status }));
      const router = new ToolRouterService(provider(defaultCreate), () =>
        provider(euCreate),
      );
      const enricher = new SkillEnricher(router);

      for (let turn = 0; turn < 2; turn++) {
        const request = context();
        expect(request.user.region).toBe('EU');
        const result = await enricher.execute(request);
        expect(result.skillRouting).toMatchObject({
          degraded: true,
          degradedReason: reason,
          degradedRegion: 'EU',
        });
        expect(result.activeSkills).toEqual([]);
        expect(request.emitMarker).toHaveBeenCalledWith(
          expect.stringContaining(
            'Automatic skill selection unavailable; explicitly selected skills still apply.',
          ),
        );
      }
      expect(euCreate).toHaveBeenCalledTimes(2);
      expect(defaultCreate).not.toHaveBeenCalled();
      expect(euCreate.mock.calls[0][0].model).toBe(AUXILIARY_ROUTER_MODEL);
      expect(euCreate.mock.calls[0][1]).toMatchObject({
        timeout: 8000,
        maxRetries: 0,
      });
    },
  );

  it('keeps explicitly selected skills during a missing EU deployment', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('DeploymentNotFound'), { status: 404 }),
      );
    const router = new ToolRouterService(provider(vi.fn()), () =>
      provider(create),
    );
    // Keep another eligible skill so the forced id does not empty the router catalog.
    vi.mocked(getVisibleSkills).mockResolvedValue([
      ...catalog,
      {
        ...catalog[0],
        skill: { ...catalog[0].skill, id: 'other', name: 'Other' },
      },
    ]);
    const request = { ...context(), forcedSkillIds: ['gdpr'] };
    const result = await new SkillEnricher(router).execute(request);
    expect(result.systemPrompt).toContain(catalog[0].skill.instructions);
    expect(request.emitMarker).toHaveBeenCalledWith(
      expect.stringContaining('GDPR Guidance (requested)'),
    );
    expect(result.skillRouting?.degraded).toBe(true);
  });

  it('does not let an EU request select the healthy US default endpoint', async () => {
    const defaultCreate = vi.fn().mockResolvedValue(selection());
    const router = new ToolRouterService(
      provider(defaultCreate),
      () => undefined,
    );
    const result = await new SkillEnricher(router).execute({
      ...context(),
      hostedRegion: 'US',
    });
    expect(result.skillRouting).toMatchObject({
      degradedReason: 'endpoint_missing',
      degradedRegion: 'EU',
    });
    expect(defaultCreate).not.toHaveBeenCalled();
  });

  it('succeeds without a warning when the EU provider returns a valid selection', async () => {
    const euCreate = vi.fn().mockResolvedValue(selection());
    const router = new ToolRouterService(provider(vi.fn()), () =>
      provider(euCreate),
    );
    const request = context();
    const result = await new SkillEnricher(router).execute(request);
    expect(result.activeSkills?.map((skill) => skill.id)).toEqual(['gdpr']);
    expect(request.emitMarker).toHaveBeenCalledWith(
      expect.stringContaining('GDPR Guidance (auto)'),
    );
    expect(request.emitMarker.mock.calls[0][0]).not.toContain(
      'Automatic skill selection unavailable',
    );
  });

  it('does not interpret disabled automatic selection as a router outage', async () => {
    const create = vi.fn();
    const router = new ToolRouterService(provider(create), () => undefined);
    const request = { ...context(), skillsAuto: false };
    const result = await new SkillEnricher(router).execute(request);
    expect(create).not.toHaveBeenCalled();
    expect(result.skillRouting).toBeUndefined();
    expect(request.emitMarker).not.toHaveBeenCalled();
  });

  it('also loses the shared tools decision when the EU provider rejects the request', async () => {
    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error('Invalid response_format schema'), {
        status: 400,
      }),
    );
    const router = new ToolRouterService(provider(vi.fn()), () =>
      provider(create),
    );
    const request = context();
    const routing = await router.determineTool({
      messages: request.messages,
      currentMessage: 'Search for recent data protection guidance',
      region: 'EU',
      skillCatalog: catalog.map(({ skill }) => skill),
      considerCodeExecution: true,
    });
    expect(routing).toMatchObject({
      tools: [],
      degraded: true,
      degradedReason: 'provider',
      degradedRegion: 'EU',
    });
    await new SkillEnricher(router).execute({
      ...request,
      skillRouting: { relevantSkills: [], degraded: routing.degraded },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(request.emitMarker).toHaveBeenCalledWith(
      expect.stringContaining('Automatic skill selection unavailable'),
    );
  });
});
