import {
  FORCED_MODEL_RETIREMENTS,
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

const ids = (models: OpenAIModel[]) => new Set(models.map((m) => m.id));
const successorOf = (id: string, models: OpenAIModel[], region: 'US' | 'EU') =>
  listRetirements({ models, region, now: NOW }).find((r) => r.model.id === id)
    ?.successor.id;

describe('the 2026-10 move off gpt-5.2 / gpt-5.2-chat / gpt-chat-latest', () => {
  it('lists exactly those three as forced', () => {
    expect([...FORCED_MODEL_RETIREMENTS].sort()).toEqual([
      'gpt-5.2',
      'gpt-5.2-chat',
      'gpt-chat-latest',
    ]);
  });

  it('moves all three to gpt-5.4 for a US user, immediately', () => {
    const moves = planRetirementMoves(
      { models: US_LIST, region: 'US', now: NOW },
      {},
    );
    expect(
      Object.fromEntries(moves.map((m) => [m.model.id, m.successor.id])),
    ).toEqual({
      'gpt-5.2': 'gpt-5.4',
      'gpt-5.2-chat': 'gpt-5.4',
      'gpt-chat-latest': 'gpt-5.4',
    });
    expect(moves.every((m) => m.signal.trigger === 'forced')).toBe(true);
  });

  it('moves all three to gpt-5.4 for an EU user — gpt-chat-latest though it is not deployed there', () => {
    const moves = planRetirementMoves(
      { models: EU_LIST, region: 'EU', now: NOW },
      {},
    );
    expect(
      Object.fromEntries(moves.map((m) => [m.model.id, m.successor.id])),
    ).toEqual({
      'gpt-5.2': 'gpt-5.4',
      'gpt-5.2-chat': 'gpt-5.4',
      'gpt-chat-latest': 'gpt-5.4',
    });
  });

  it('still moves a forced model whose deployment has since been deleted', () => {
    const withoutChat = US_LIST.filter((m) => m.id !== 'gpt-5.2-chat');
    expect(successorOf('gpt-5.2-chat', withoutChat, 'US')).toBe('gpt-5.4');
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
      trigger: retiresAt,
      retiresAt,
      movesAt: inDays(23),
    });
    expect(getRetirementSignal(model(inDays(8)), servedIds, NOW)?.phase).toBe(
      'notice',
    );
  });

  it('moves from 7 days before, and after the date has passed', () => {
    expect(getRetirementSignal(model(inDays(7)), servedIds, NOW)?.phase).toBe(
      'move',
    );
    expect(getRetirementSignal(model(inDays(-3)), servedIds, NOW)?.phase).toBe(
      'move',
    );
  });

  it('moves an alias at once — only when the underlying model is itself served', () => {
    expect(
      getRetirementSignal(model(undefined, 'gpt-5.4'), servedIds, NOW),
    ).toEqual({ phase: 'move', reason: 'alias', trigger: 'alias:gpt-5.4' });
    // A custom deployment name, not an alias of something on offer.
    expect(
      getRetirementSignal(
        model(undefined, 'gpt-5.1-2025-11-13'),
        servedIds,
        NOW,
      ),
    ).toBeNull();
  });
});

describe('resolveSuccessor', () => {
  const retiring = (id: string, facts: Partial<OpenAIModel> = {}) =>
    served(id, { retiresAt: inDays(3), ...facts });

  it('prefers the region default when it is in the same family', () => {
    // gpt-5.1's own variant line has newer members (5.6, 6); the default wins.
    const list = [...US_LIST, retiring('gpt-5.1')];
    expect(resolveSuccessor(list.at(-1)!, list, 'US', NOW)?.id).toBe('gpt-5.4');
  });

  it('honours a usable ui-successor tag, and ignores an unusable one', () => {
    const tagged = retiring('gpt-5.1', { successorId: 'gpt-5.6-sol' });
    expect(resolveSuccessor(tagged, [...US_LIST, tagged], 'US', NOW)?.id).toBe(
      'gpt-5.6-sol',
    );
    const dangling = retiring('gpt-5.1', { successorId: 'not-deployed' });
    expect(
      resolveSuccessor(dangling, [...US_LIST, dangling], 'US', NOW)?.id,
    ).toBe('gpt-5.4');
  });

  it('stays in the family and variant when the default is another family', () => {
    const list = [
      served('gpt-5.4'),
      retiring('claude-sonnet-4-5'),
      served('claude-sonnet-4-6'),
      served('claude-sonnet-5'),
      served('claude-opus-5'),
    ];
    expect(resolveSuccessor(list[1], list, 'US', NOW)?.id).toBe(
      'claude-sonnet-5',
    );
  });

  it("falls back to the family's own default when the variant has nothing left", () => {
    const list = [
      served('gpt-5.4'),
      retiring('claude-haiku-4-5'),
      served('claude-sonnet-5'),
      served('claude-opus-5'),
    ];
    const successor = resolveSuccessor(list[1], list, 'US', NOW);
    expect(
      successor && OpenAIModels[successor.id as OpenAIModelID].series,
    ).toBe('claude');
  });

  it('falls back to the region default when the family has nothing left', () => {
    const list = [served('gpt-5.4'), retiring('claude-haiku-4-5')];
    expect(resolveSuccessor(list[1], list, 'US', NOW)?.id).toBe('gpt-5.4');
  });

  it('never picks a model that is itself leaving, disabled, or not selectable in the region', () => {
    const leavingDefault = [
      served('gpt-5.4', { retiresAt: inDays(20) }), // in its notice window
      served('gpt-5.6-sol'),
      retiring('gpt-5.1'),
    ];
    expect(
      resolveSuccessor(leavingDefault[2], leavingDefault, 'US', NOW)?.id,
    ).toBe('gpt-5.6-sol');

    const usOnlyDefault = [
      served('gpt-5.4', { hostedIn: ['US'] }),
      served('gpt-5.5', EU),
      retiring('gpt-5.1', EU),
    ];
    expect(
      resolveSuccessor(usOnlyDefault[2], usOnlyDefault, 'EU', NOW)?.id,
    ).toBe('gpt-5.5');

    const nothingLeft = [retiring('gpt-5.1')];
    expect(resolveSuccessor(nothingLeft[0], nothingLeft, 'US', NOW)).toBeNull();
  });
});

describe('planRetirementMoves / getRetirementNotice', () => {
  const list = (retiresAt: string) => [
    served('gpt-5.4'),
    served('gpt-5.1', { retiresAt }),
  ];
  const context = (retiresAt: string) => ({
    models: list(retiresAt),
    region: 'US' as const,
    now: NOW,
  });
  // The forced entries are not under test here.
  const forcedApplied = Object.fromEntries(
    FORCED_MODEL_RETIREMENTS.map((id) => [id, 'forced']),
  );
  const pending = (retiresAt: string, applied: Record<string, string>) =>
    planRetirementMoves(context(retiresAt), {
      ...forcedApplied,
      ...applied,
    }).map((m) => m.model.id);

  it('plans a move only inside the 7-day window; before that it is a notice', () => {
    expect(pending(inDays(20), {})).toEqual([]);
    const notice = getRetirementNotice('gpt-5.1', context(inDays(20)));
    expect(notice?.successor.id).toBe('gpt-5.4');
    expect(notice?.signal.movesAt).toBe(inDays(13));

    expect(pending(inDays(5), {})).toEqual(['gpt-5.1']);
    expect(getRetirementNotice('gpt-5.1', context(inDays(5)))).toBeNull();
  });

  it('applies each retirement event once, and a new event again', () => {
    const date = inDays(5);
    expect(pending(date, { 'gpt-5.1': date })).toEqual([]);
    // Azure moved the date: a different event.
    expect(pending(inDays(6), { 'gpt-5.1': date })).toEqual(['gpt-5.1']);
    // Forced earlier, now really retiring.
    expect(pending(date, { 'gpt-5.1': 'forced' })).toEqual(['gpt-5.1']);
  });

  it('has no notice for a model that is staying, or for no model', () => {
    expect(getRetirementNotice('gpt-5.4', context(inDays(20)))).toBeNull();
    expect(getRetirementNotice(undefined, context(inDays(20)))).toBeNull();
  });
});

describe('moveConversationsToSuccessors', () => {
  const target = served('gpt-5.4');
  const successors = new Map([
    ['gpt-5.2', target],
    ['gpt-5.2-chat', target],
  ]);
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

  it('moves conversations on a leaving model and leaves the rest untouched', () => {
    const other = conversation('c3', 'claude-sonnet-5');
    const moved = moveConversationsToSuccessors(
      [
        conversation('c1', 'gpt-5.2-chat'),
        conversation('c2', 'gpt-5.2'),
        other,
      ],
      successors,
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
    expect(moveConversationsToSuccessors(conversations, successors)).toBe(
      conversations,
    );
  });

  it('advances updatedAt by the minimum so the move persists without reordering', () => {
    const [moved] = moveConversationsToSuccessors(
      [conversation('c1', 'gpt-5.2')],
      successors,
    );
    expect(moved.updatedAt).toBe('2026-09-01T10:00:00.001Z');
  });

  it('stamps a conversation that has no updatedAt at all', () => {
    const [moved] = moveConversationsToSuccessors(
      [conversation('c1', 'gpt-5.2', { updatedAt: undefined })],
      successors,
    );
    expect(Number.isNaN(Date.parse(moved.updatedAt ?? ''))).toBe(false);
  });

  it('drops AGENT search routing the target cannot serve, and keeps other modes', () => {
    const moved = moveConversationsToSuccessors(
      [
        conversation('c1', 'gpt-5.2', { defaultSearchMode: SearchMode.AGENT }),
        conversation('c2', 'gpt-5.2', { defaultSearchMode: SearchMode.OFF }),
      ],
      successors,
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

  it('keeps the thread id and moves a remembered pre-agent model', () => {
    const moved = moveConversationsToSuccessors(
      [
        conversation('c1', 'gpt-5.2', { threadId: 'thread_1' }),
        conversation('c2', 'foundry-abc-agent', {
          agentPrevModelId: 'gpt-5.2-chat',
        }),
      ],
      successors,
    );
    expect(moved[0].threadId).toBe('thread_1');
    expect(moved[1].model.id).toBe('foundry-abc-agent');
    expect(moved[1].agentPrevModelId).toBe('gpt-5.4');
  });
});
