import {
  AppliedRetirement,
  FORCED_MODEL_RETIREMENTS,
  RetirementMove,
  getRetirementNotice,
  getRetirementSignal,
  listRetirements,
  moveConversationsToSuccessors,
  planRetirementMoves,
  resolveSuccessor,
  successorUpdates,
} from '@/lib/utils/shared/modelRetirement';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { describe, expect, it } from 'vitest';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW + days * DAY).toISOString();

/** A served model: real catalog metadata + the runtime facts discovery adds. */
const served = (id: string, facts: Partial<OpenAIModel> = {}): OpenAIModel => {
  const meta = OpenAIModels[id as OpenAIModelID];
  if (!meta) throw new Error(`not in catalog: ${id}`);
  return { ...meta, hostedIn: ['US'], ...facts };
};

/**
 * The GPT deployments of the two production accounts as read on 2026-10-02
 * (deployment name → underlying model, and Azure's retirement date for the
 * deployed version), plus one Claude model for the cross-family cases.
 */
const US_LIST: OpenAIModel[] = [
  served('gpt-4.1'),
  served('gpt-5.2-chat', {
    deploymentModelName: 'gpt-chat-latest',
    retiresAt: '2026-10-05T00:00:00Z',
  }),
  served('gpt-5.2', { retiresAt: '2027-06-08T00:00:00Z' }),
  served('gpt-5-mini'),
  served('gpt-5.4-nano'),
  served('gpt-5.6-sol'),
  served('gpt-5.6-terra'),
  served('gpt-5.6-luna'),
  served('gpt-5.4', { retiresAt: '2027-09-02T00:00:00Z' }),
  served('gpt-chat-latest', { retiresAt: '2026-12-02T00:00:00Z' }),
  served('gpt-6-astra'),
  served('claude-sonnet-5'),
];
const EU = { hostedIn: ['EU'] as ('US' | 'EU')[] };
const EU_LIST: OpenAIModel[] = [
  served('gpt-5-mini', EU),
  served('gpt-4.1', EU),
  served('gpt-5.2-chat', { ...EU, deploymentModelName: 'gpt-5.4' }),
  served('gpt-5.2', { ...EU, deploymentModelName: 'gpt-5.4' }),
  served('gpt-5.4', { ...EU, retiresAt: '2027-09-02T00:00:00Z' }),
  served('gpt-5.5', EU),
  served('gpt-5.6-sol', EU),
  served('gpt-5.1', EU),
  served('gpt-5.4-mini', EU),
  served('gpt-6-astra', EU),
];

const FORCED_IDS = Object.keys(FORCED_MODEL_RETIREMENTS);
const without = (models: OpenAIModel[], id: string) =>
  models.filter((m) => m.id !== id);
const retirementOf = (id: string, models: OpenAIModel[], region: 'US' | 'EU') =>
  listRetirements({ models, region, now: NOW }).find((r) => r.model.id === id);
const successorOf = (id: string, models: OpenAIModel[], region: 'US' | 'EU') =>
  retirementOf(id, models, region)?.successor.id;
const successorsOf = (moves: RetirementMove[]) =>
  Object.fromEntries(moves.map((m) => [m.model.id, m.successor.id]));

describe('the 2026-10 move off gpt-5.2 / gpt-5.2-chat / gpt-chat-latest', () => {
  it('pins exactly those three to gpt-5.4', () => {
    expect(FORCED_MODEL_RETIREMENTS).toEqual({
      'gpt-5.2': 'gpt-5.4',
      'gpt-5.2-chat': 'gpt-5.4',
      'gpt-chat-latest': 'gpt-5.4',
    });
  });

  it.each([
    ['US', US_LIST],
    ['EU', EU_LIST], // gpt-chat-latest is not even deployed there
  ] as const)(
    'moves all three to gpt-5.4 for a %s user, at once',
    (region, list) => {
      const moves = planRetirementMoves({ models: list, region, now: NOW }, {});
      expect(successorsOf(moves)).toEqual({
        'gpt-5.2': 'gpt-5.4',
        'gpt-5.2-chat': 'gpt-5.4',
        'gpt-chat-latest': 'gpt-5.4',
      });
      expect(moves.every((m) => m.kind === 'event')).toBe(true);
    },
  );

  it('still moves a forced model whose deployment has since been deleted', () => {
    expect(
      successorOf('gpt-5.2-chat', without(US_LIST, 'gpt-5.2-chat'), 'US'),
    ).toBe('gpt-5.4');
  });

  it('WAITS while gpt-5.4 is unavailable instead of landing somewhere else', () => {
    // Hidden by a usage limit, ring-gated, or not provisioned at this fill.
    const eu = planRetirementMoves(
      { models: without(EU_LIST, 'gpt-5.4'), region: 'EU', now: NOW },
      {},
    );
    expect(eu).toEqual([]);

    const us = planRetirementMoves(
      { models: without(US_LIST, 'gpt-5.4'), region: 'US', now: NOW },
      {},
    );
    // gpt-5.2 and gpt-chat-latest are forced only: they wait. gpt-5.2-chat is
    // ALSO dying on its own (alias + 3 days left), so it has to go somewhere.
    expect(us.map((m) => m.model.id)).toEqual(['gpt-5.2-chat']);
    expect(us[0].successor.id).not.toBe('gpt-5.4');
  });

  it('records every reason that holds, so emptying the forced list moves nobody twice', () => {
    expect(
      retirementOf('gpt-5.2-chat', US_LIST, 'US')?.signal.triggers,
    ).toEqual(['forced', 'alias:gpt-chat-latest', '2026-10-05T00:00:00Z']);
    expect(retirementOf('gpt-5.2', EU_LIST, 'EU')?.signal.triggers).toEqual([
      'forced',
      'alias:gpt-5.4',
    ]);
    // A plain forced model has no other reason today.
    expect(retirementOf('gpt-5.2', US_LIST, 'US')?.signal.triggers).toEqual([
      'forced',
    ]);
  });
});

describe('getRetirementSignal', () => {
  const model = (retiresAt?: string, deploymentModelName?: string) => ({
    id: 'gpt-5.1',
    retiresAt,
    deploymentModelName,
  });
  const servedIds = new Set(['gpt-5.1', 'gpt-5.4']);

  it('is null without a date, with an unparseable one, or more than 30 days out', () => {
    expect(getRetirementSignal(model(), servedIds, NOW)).toBeNull();
    expect(getRetirementSignal(model('soon'), servedIds, NOW)).toBeNull();
    expect(getRetirementSignal(model(inDays(31)), servedIds, NOW)).toBeNull();
  });

  it('gives notice from 30 days before, naming the move date 7 days before retirement', () => {
    const retiresAt = inDays(30);
    expect(getRetirementSignal(model(retiresAt), servedIds, NOW)).toEqual({
      phase: 'notice',
      reason: 'date',
      triggers: [],
      retiresAt,
      movesAt: inDays(23),
    });
    expect(getRetirementSignal(model(inDays(8)), servedIds, NOW)?.phase).toBe(
      'notice',
    );
  });

  it('moves from 7 days before, and after the date has passed', () => {
    const due = inDays(7);
    expect(getRetirementSignal(model(due), servedIds, NOW)).toMatchObject({
      phase: 'move',
      triggers: [due],
    });
    expect(getRetirementSignal(model(inDays(-3)), servedIds, NOW)?.phase).toBe(
      'move',
    );
  });

  it('moves an alias at once — only when the underlying model is itself served', () => {
    expect(
      getRetirementSignal(model(undefined, 'gpt-5.4'), servedIds, NOW),
    ).toEqual({ phase: 'move', reason: 'alias', triggers: ['alias:gpt-5.4'] });
    // A custom deployment name, not an alias of something on offer.
    expect(
      getRetirementSignal(
        model(undefined, 'gpt-5.1-2025-11-13'),
        servedIds,
        NOW,
      ),
    ).toBeNull();
  });

  it('keeps the date visible on an alias that is also inside its notice window', () => {
    const retiresAt = inDays(20);
    expect(
      getRetirementSignal(model(retiresAt, 'gpt-5.4'), servedIds, NOW),
    ).toEqual({
      phase: 'move',
      reason: 'alias',
      // The date is not a MOVE trigger yet — it becomes one 7 days before.
      triggers: ['alias:gpt-5.4'],
      retiresAt,
      movesAt: inDays(13),
    });
  });
});

describe('resolveSuccessor', () => {
  const retiring = (id: string, facts: Partial<OpenAIModel> = {}) =>
    served(id, { retiresAt: inDays(3), ...facts });
  const successor = (
    list: OpenAIModel[],
    id: string,
    region: 'US' | 'EU' = 'US',
  ) => resolveSuccessor(list.find((m) => m.id === id)!, list, region, NOW)?.id;

  it('goes to the region default when it shares the family and variant', () => {
    // gpt-5.1's own line has newer members (5.6, 6); the default wins.
    expect(successor([...US_LIST, retiring('gpt-5.1')], 'gpt-5.1')).toBe(
      'gpt-5.4',
    );
  });

  it('keeps the variant: a retiring Mini goes to the next Mini, not the flagship', () => {
    const list = [
      served('gpt-5.4'),
      retiring('gpt-5-mini'),
      served('gpt-5.4-mini'),
      served('gpt-6-astra'),
    ];
    expect(successor(list, 'gpt-5-mini')).toBe('gpt-5.4-mini');
  });

  it('picks the NEAREST newer version of the variant, not the newest', () => {
    const list = [
      served('gpt-5.4'),
      retiring('claude-sonnet-4-5'),
      served('claude-sonnet-4-6'),
      served('claude-sonnet-5'),
      served('claude-opus-5'),
    ];
    expect(successor(list, 'claude-sonnet-4-5')).toBe('claude-sonnet-4-6');
    // Nothing newer left in the variant: the nearest older one.
    expect(
      successor(
        [
          served('gpt-5.4'),
          served('claude-sonnet-4-6'),
          retiring('claude-sonnet-5'),
        ],
        'claude-sonnet-5',
      ),
    ).toBe('claude-sonnet-4-6');
  });

  it('prefers a same-version sibling over another version', () => {
    const list = [
      served('gpt-5.4'),
      retiring('gpt-5.6-terra'),
      served('gpt-5.6-luna'),
      served('gpt-6-astra'),
    ];
    // Closer than the policy default, and closer than the newest model.
    expect(successor(list, 'gpt-5.6-terra')).toBe('gpt-5.6-luna');
  });

  it('sends an alias to the model its deployment actually runs', () => {
    const list = [
      served('gpt-5.4'),
      served('gpt-5-mini', { deploymentModelName: 'gpt-5.4-mini' }),
      served('gpt-5.4-mini'),
      served('claude-opus-4-6', { deploymentModelName: 'claude-opus-4-8' }),
      served('claude-opus-4-8'),
      served('claude-opus-5'),
    ];
    expect(successor(list, 'gpt-5-mini')).toBe('gpt-5.4-mini');
    expect(successor(list, 'claude-opus-4-6')).toBe('claude-opus-4-8');
  });

  it('honours a usable ui-successor tag, and ignores an unusable one', () => {
    const tagged = retiring('gpt-5.1', { successorId: 'gpt-5.6-sol' });
    expect(successor([...US_LIST, tagged], 'gpt-5.1')).toBe('gpt-5.6-sol');
    const dangling = retiring('gpt-5.1', { successorId: 'not-deployed' });
    expect(successor([...US_LIST, dangling], 'gpt-5.1')).toBe('gpt-5.4');
  });

  it('without the policy default, takes the nearest newer version — not the newest', () => {
    const list = [
      retiring('gpt-5.1'),
      served('gpt-5.5'),
      served('gpt-5.6-sol'),
      served('gpt-6-astra'),
    ];
    expect(successor(list, 'gpt-5.1')).toBe('gpt-5.5');
  });

  it("falls back to the family's own default, then to the region default", () => {
    const familyLeft = [
      served('gpt-5.4'),
      retiring('claude-haiku-4-5'),
      served('claude-sonnet-5'),
      served('claude-opus-5'),
    ];
    const next = successor(familyLeft, 'claude-haiku-4-5');
    expect(next && OpenAIModels[next as OpenAIModelID].series).toBe('claude');

    expect(
      successor(
        [served('gpt-5.4'), retiring('claude-haiku-4-5')],
        'claude-haiku-4-5',
      ),
    ).toBe('gpt-5.4');
  });

  it('never moves from an Azure-hosted model onto an externally hosted one — not even by tag', () => {
    const tagged = retiring('gpt-5.1', { successorId: 'claude-opus-5' });
    const list = [served('gpt-5.4'), served('claude-opus-5'), tagged];
    expect(successor(list, 'gpt-5.1')).toBe('gpt-5.4');
    // Nothing Azure-hosted left: no successor rather than an external one.
    expect(
      successor([served('claude-opus-5'), tagged], 'gpt-5.1'),
    ).toBeUndefined();
  });

  it('never moves a US user from a home-hosted model onto an EU-only one', () => {
    const list = [
      served('gpt-5.4', EU),
      served('gpt-5.6-sol'),
      retiring('gpt-5.1'),
    ];
    expect(successor(list, 'gpt-5.1')).toBe('gpt-5.6-sol');
    // A model that itself only exists in the EU may stay there.
    const euOnly = [served('gpt-5.4', EU), retiring('gpt-5.1', EU)];
    expect(successor(euOnly, 'gpt-5.1')).toBe('gpt-5.4');
  });

  it('never picks a model that is itself leaving, disabled, or not selectable in the region', () => {
    const leavingDefault = [
      served('gpt-5.4', { retiresAt: inDays(20) }), // in its notice window
      served('gpt-5.6-sol'),
      retiring('gpt-5.1'),
    ];
    expect(successor(leavingDefault, 'gpt-5.1')).toBe('gpt-5.6-sol');

    const usOnlyDefault = [
      served('gpt-5.4', { hostedIn: ['US'] }),
      served('gpt-5.5', EU),
      retiring('gpt-5.1', EU),
    ];
    expect(successor(usOnlyDefault, 'gpt-5.1', 'EU')).toBe('gpt-5.5');

    expect(successor([retiring('gpt-5.1')], 'gpt-5.1')).toBeUndefined();
  });
});

describe('planRetirementMoves', () => {
  const forcedApplied: Record<string, AppliedRetirement> = Object.fromEntries(
    FORCED_IDS.map((id) => [
      id,
      { triggers: ['forced'], appliedAt: inDays(-1) },
    ]),
  );
  const list = (retiresAt: string) => [
    served('gpt-5.4'),
    served('gpt-5.1', { retiresAt }),
  ];
  const plan = (
    models: OpenAIModel[],
    applied: Record<string, AppliedRetirement> = {},
  ) =>
    planRetirementMoves(
      { models, region: 'US', now: NOW },
      { ...forcedApplied, ...applied },
    ).filter((m) => !FORCED_IDS.includes(m.model.id));
  const kinds = (moves: RetirementMove[]) =>
    Object.fromEntries(moves.map((m) => [m.model.id, m.kind]));

  it('plans nothing before the 7-day window', () => {
    expect(plan(list(inDays(20)))).toEqual([]);
  });

  it('plans an event once, then only catch-ups for the same event', () => {
    const date = inDays(5);
    expect(kinds(plan(list(date)))).toEqual({ 'gpt-5.1': 'event' });

    const done = { 'gpt-5.1': { triggers: [date], appliedAt: inDays(-1) } };
    const again = plan(list(date), done);
    expect(kinds(again)).toEqual({ 'gpt-5.1': 'catchUp' });
    expect(again[0].appliedAt).toBe(inDays(-1));
  });

  it('treats a trigger it has not applied as a new event', () => {
    const date = inDays(5);
    // Azure moved the date.
    expect(
      kinds(
        plan(list(inDays(6)), {
          'gpt-5.1': { triggers: [date], appliedAt: inDays(-1) },
        }),
      ),
    ).toEqual({ 'gpt-5.1': 'event' });
    // Forced months ago, now really retiring.
    expect(
      kinds(
        plan(list(date), {
          'gpt-5.1': { triggers: ['forced'], appliedAt: inDays(-90) },
        }),
      ),
    ).toEqual({ 'gpt-5.1': 'event' });
  });

  it('does not re-move when an already-applied reason is merely unmasked or alternates', () => {
    // Alias target present → triggers are [alias, date]; target drops out of
    // the list (EU discovery failed) → [date] alone. Both were applied.
    const date = inDays(3);
    const done = {
      'gpt-5.1': { triggers: ['alias:gpt-5.5', date], appliedAt: inDays(-1) },
    };
    const aliased = served('gpt-5.1', {
      retiresAt: date,
      deploymentModelName: 'gpt-5.5',
    });
    expect(
      kinds(plan([served('gpt-5.4'), served('gpt-5.5'), aliased], done)),
    ).toEqual({ 'gpt-5.1': 'catchUp' });
    expect(kinds(plan([served('gpt-5.4'), aliased], done))).toEqual({
      'gpt-5.1': 'catchUp',
    });
  });

  it('moves an alias through the plan to the model it runs', () => {
    const moves = planRetirementMoves(
      { models: EU_LIST, region: 'EU', now: NOW },
      {},
    );
    expect(moves.find((m) => m.model.id === 'gpt-5.2')).toMatchObject({
      kind: 'event',
      successor: { id: 'gpt-5.4' },
    });
  });
});

describe('regions retire separately', () => {
  // One model id, two deployments: the US one retires in 3 days, the EU one
  // is fine. A US user's unpinned conversations are served by the US one.
  const both = { hostedIn: ['US', 'EU'] as ('US' | 'EU')[] };
  const usRetiring = (id: string) =>
    served(id, {
      ...both,
      retiresAt: inDays(3),
      retirementByRegion: { US: { retiresAt: inDays(3) }, EU: {} },
    });
  const list = [served('gpt-5.4', both), usRetiring('gpt-5.1')];
  const leaving = (routedRegion?: 'US' | 'EU') =>
    listRetirements({ models: list, region: 'US', now: NOW, routedRegion })
      .map((r) => r.model.id)
      .filter((id) => !FORCED_IDS.includes(id));

  it('judges a conversation by the deployment that serves it', () => {
    expect(leaving()).toEqual(['gpt-5.1']);
    // Pinned to the EU instance, which is not retiring.
    expect(leaving('EU')).toEqual([]);
  });

  it('applies an EU-only repoint to EU-routed conversations only', () => {
    const repointedInEu = served('gpt-5.1', {
      ...both,
      retirementByRegion: {
        US: {},
        EU: { deploymentModelName: 'gpt-5.4' },
      },
    });
    const models = [served('gpt-5.4', both), repointedInEu];
    const ids = (routedRegion?: 'US' | 'EU') =>
      listRetirements({ models, region: 'US', now: NOW, routedRegion })
        .map((r) => r.model.id)
        .filter((id) => !FORCED_IDS.includes(id));
    expect(ids()).toEqual([]);
    expect(ids('EU')).toEqual(['gpt-5.1']);
  });

  it('serves a US user on an EU-only model from the EU deployment', () => {
    const euOnly = served('gpt-5.1', {
      ...EU,
      retirementByRegion: { EU: { retiresAt: inDays(3) } },
    });
    expect(
      listRetirements({
        models: [served('gpt-5.4', both), euOnly],
        region: 'US',
        now: NOW,
      }).some((r) => r.model.id === 'gpt-5.1'),
    ).toBe(true);
  });

  it('keeps an EU-pinned conversation in the EU when it does have to move', () => {
    const models = [
      served('gpt-5.4'), // US only
      served('gpt-5.5', both),
      served('gpt-5.1', {
        ...both,
        retirementByRegion: { US: {}, EU: { retiresAt: inDays(3) } },
      }),
    ];
    expect(
      resolveSuccessor(models[2], models, 'US', NOW, 'EU')?.hostedIn,
    ).toContain('EU');
  });

  it('moves pinned conversations by their own region’s plan', () => {
    const context = { models: list, region: 'US' as const, now: NOW };
    const applied = Object.fromEntries(
      FORCED_IDS.map((id) => [
        id,
        { triggers: ['forced'], appliedAt: inDays(-1) },
      ]),
    );
    const conversation = (id: string, extra: Partial<Conversation> = {}) =>
      ({
        id,
        name: id,
        messages: [],
        model: { id: 'gpt-5.1', name: 'gpt-5.1' } as OpenAIModel,
        prompt: '',
        temperature: 0.7,
        folderId: null,
        updatedAt: '2026-09-01T10:00:00.000Z',
        ...extra,
      }) as Conversation;
    const moved = moveConversationsToSuccessors(
      [
        conversation('unpinned'),
        conversation('pinned', { hostedRegion: 'EU' }),
      ],
      planRetirementMoves(context, applied),
      undefined,
      { EU: planRetirementMoves({ ...context, routedRegion: 'EU' }, applied) },
    );
    expect(moved.map((c) => c.model.id)).toEqual(['gpt-5.4', 'gpt-5.1']);
  });
});

describe('getRetirementNotice', () => {
  const context = (retiresAt: string) => ({
    models: [served('gpt-5.4'), served('gpt-5.1', { retiresAt })],
    region: 'US' as const,
    now: NOW,
  });

  it('announces the move while it is still ahead', () => {
    const notice = getRetirementNotice('gpt-5.1', context(inDays(20)));
    expect(notice?.signal.phase).toBe('notice');
    expect(notice?.successor.id).toBe('gpt-5.4');
    expect(notice?.signal.movesAt).toBe(inDays(13));
  });

  it('still warns inside the move window — for a conversation that is on the model again', () => {
    const notice = getRetirementNotice('gpt-5.1', context(inDays(5)));
    expect(notice?.signal.phase).toBe('move');
    expect(notice?.signal.retiresAt).toBe(inDays(5));
  });

  it('has nothing to say about a staying model, a dateless move, or no model', () => {
    expect(getRetirementNotice('gpt-5.4', context(inDays(20)))).toBeNull();
    expect(getRetirementNotice(undefined, context(inDays(20)))).toBeNull();
    // Forced, no date in the window.
    expect(
      getRetirementNotice('gpt-5.2', {
        models: US_LIST,
        region: 'US',
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe('moveConversationsToSuccessors', () => {
  const target = served('gpt-5.4');
  const APPLIED_AT = '2026-10-01T00:00:00.000Z';
  const move = (
    id: string,
    kind: RetirementMove['kind'] = 'event',
  ): RetirementMove => ({
    model: served(id),
    signal: { phase: 'move', reason: 'forced', triggers: ['forced'] },
    successor: target,
    kind,
    ...(kind === 'catchUp' ? { appliedAt: APPLIED_AT } : {}),
  });
  const events = [move('gpt-5.2'), move('gpt-5.2-chat')];
  const conversation = (
    id: string,
    modelId: string,
    extra: Partial<Conversation> = {},
  ): Conversation => ({
    id,
    name: id,
    messages: [],
    model: { id: modelId, name: modelId } as OpenAIModel,
    prompt: '',
    temperature: 0.7,
    folderId: null,
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...extra,
  });

  it('an event moves every conversation on a leaving model and leaves the rest untouched', () => {
    const other = conversation('c3', 'claude-sonnet-5');
    const moved = moveConversationsToSuccessors(
      [
        conversation('c1', 'gpt-5.2-chat'),
        conversation('c2', 'gpt-5.2', { updatedAt: inDays(0) }),
        other,
      ],
      events,
    );
    expect(moved.map((c) => c.model.id)).toEqual([
      'gpt-5.4',
      'gpt-5.4',
      'claude-sonnet-5',
    ]);
    expect(moved[2]).toBe(other);
  });

  it('returns the same array when nothing is on a leaving model', () => {
    const conversations = [conversation('c1', 'gpt-5.4')];
    expect(moveConversationsToSuccessors(conversations, events)).toBe(
      conversations,
    );
  });

  describe('timestamps', () => {
    it('advances updatedAt by the minimum so the move persists without reordering', () => {
      const [moved] = moveConversationsToSuccessors(
        [conversation('c1', 'gpt-5.2')],
        events,
      );
      expect(moved.updatedAt).toBe('2026-09-01T10:00:00.001Z');
    });

    it('falls back to createdAt, the same order the backup merge uses', () => {
      const [moved] = moveConversationsToSuccessors(
        [
          conversation('c1', 'gpt-5.2', {
            updatedAt: undefined,
            createdAt: '2026-08-01T10:00:00.000Z',
          }),
        ],
        events,
      );
      expect(moved.updatedAt).toBe('2026-08-01T10:00:00.001Z');
    });

    it('NEVER stamps "now" on a conversation that has no timestamp — it would beat a newer copy elsewhere', () => {
      const [moved] = moveConversationsToSuccessors(
        [conversation('c1', 'gpt-5.2', { updatedAt: undefined })],
        events,
      );
      expect(moved.model.id).toBe('gpt-5.4');
      expect(moved.updatedAt).toBeUndefined();
    });
  });

  describe('catch-up (the event was applied earlier)', () => {
    const catchUps = [move('gpt-5.2', 'catchUp')];

    it('moves a conversation that predates the applied move — a restore, an import, a sync pull', () => {
      const [moved] = moveConversationsToSuccessors(
        [
          conversation('c1', 'gpt-5.2', {
            updatedAt: '2026-09-30T00:00:00.000Z',
          }),
        ],
        catchUps,
      );
      expect(moved.model.id).toBe('gpt-5.4');
    });

    it('leaves a conversation touched after the applied move: that is the user choosing the model again', () => {
      const conversations = [
        conversation('c1', 'gpt-5.2', {
          updatedAt: '2026-10-01T08:00:00.000Z',
        }),
      ];
      expect(moveConversationsToSuccessors(conversations, catchUps)).toBe(
        conversations,
      );
    });

    it('moves an untouched conversation, unless the model is the user’s default again', () => {
      const untouched = [
        conversation('c1', 'gpt-5.2', { updatedAt: undefined }),
      ];
      expect(
        moveConversationsToSuccessors(untouched, catchUps, 'gpt-5.4')[0].model
          .id,
      ).toBe('gpt-5.4');
      expect(
        moveConversationsToSuccessors(untouched, catchUps, 'gpt-5.2'),
      ).toBe(untouched);
    });
  });

  it('drops AGENT search routing the target cannot serve, and keeps other modes', () => {
    const moved = moveConversationsToSuccessors(
      [
        conversation('c1', 'gpt-5.2', { defaultSearchMode: SearchMode.AGENT }),
        conversation('c2', 'gpt-5.2', { defaultSearchMode: SearchMode.OFF }),
      ],
      events,
    );
    expect(moved[0].defaultSearchMode).toBe(SearchMode.INTELLIGENT);
    expect(moved[1].defaultSearchMode).toBe(SearchMode.OFF);
    expect(
      successorUpdates(
        { defaultSearchMode: SearchMode.AGENT },
        served('gpt-4.1'), // has a Foundry agent: AGENT routing survives
      ).defaultSearchMode,
    ).toBeUndefined();
  });

  it('drops a pinned region the target is not hosted in, and keeps one it is', () => {
    expect(
      successorUpdates({ hostedRegion: 'EU' }, served('gpt-5.4')),
    ).toHaveProperty('hostedRegion', undefined);
    expect(
      successorUpdates(
        { hostedRegion: 'EU' },
        served('gpt-5.4', { hostedIn: ['US', 'EU'] }),
      ),
    ).not.toHaveProperty('hostedRegion');
  });

  it('keeps the thread id and moves a remembered pre-agent model', () => {
    const moved = moveConversationsToSuccessors(
      [
        conversation('c1', 'gpt-5.2', { threadId: 'thread_1' }),
        conversation('c2', 'foundry-abc-agent', {
          agentPrevModelId: 'gpt-5.2-chat',
        }),
      ],
      events,
    );
    expect(moved[0].threadId).toBe('thread_1');
    expect(moved[1].model.id).toBe('foundry-abc-agent');
    expect(moved[1].agentPrevModelId).toBe('gpt-5.4');
  });
});
