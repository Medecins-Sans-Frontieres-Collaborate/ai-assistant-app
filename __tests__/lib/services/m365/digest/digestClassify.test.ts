import {
  classifyDigestItems,
  digestPriority,
  extractDigestInsights,
  fallbackActionItems,
  heuristicCategory,
  isActionEligible,
  reconcileCategory,
  sortByDigestPriority,
} from '@/lib/services/m365/digest/digestClassify';
import { runUtilityJson } from '@/lib/services/m365/tools/mailOrchestration';

import type { DigestItem, DigestItemSignals } from '@/types/m365Digest';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/m365/tools/mailOrchestration', () => ({
  runUtilityJson: vi.fn(),
}));

const signals = (
  extra: Partial<DigestItemSignals> = {},
): DigestItemSignals => ({
  unanswered: false,
  mentionsMe: false,
  waitingOnOthers: false,
  broadcast: false,
  invitation: false,
  important: false,
  ageHours: 5,
  ...extra,
});

const item = (id: string, extra: Partial<DigestItem> = {}): DigestItem => ({
  id,
  source: 'mail',
  category: 'fyi',
  title: 'Subject',
  from: 'Ana',
  fromAddress: 'ana@example.org',
  whenIso: '2026-10-30T08:00:00.000Z',
  preview: '',
  reason: '',
  signals: signals(),
  ref: { messageId: id },
  ...extra,
});

describe('heuristicCategory', () => {
  it('files an unanswered direct mail as needsReply, or askedOfMe when it asks for something', () => {
    expect(
      heuristicCategory(
        item('mail:1', {
          signals: signals({ unanswered: true, mentionsMe: true }),
        }),
      ).category,
    ).toBe('needsReply');
    expect(
      heuristicCategory(
        item('mail:2', {
          preview: 'Could you review the attached budget by Friday?',
          signals: signals({ unanswered: true, mentionsMe: true }),
        }),
      ).category,
    ).toBe('askedOfMe');
  });

  it('treats broadcasts and update-shaped subjects as company updates, never needsReply', () => {
    expect(
      heuristicCategory(
        item('mail:3', {
          signals: signals({ broadcast: true, recipients: 40 }),
        }),
      ).category,
    ).toBe('companyUpdates');
    expect(
      heuristicCategory(
        item('mail:4', { title: 'Project Atlas — weekly update' }),
      ).category,
    ).toBe('companyUpdates');
  });

  it('invitations are scheduling and silent threads are waitingOnOthers', () => {
    expect(
      heuristicCategory(
        item('calendar:1', {
          signals: signals({
            invitation: true,
            unanswered: true,
            mentionsMe: true,
          }),
        }),
      ).category,
    ).toBe('scheduling');
    expect(
      heuristicCategory(
        item('mail:5', { signals: signals({ waitingOnOthers: true }) }),
      ).category,
    ).toBe('waitingOnOthers');
  });

  it('automated senders are bulk unless they address the reader', () => {
    expect(
      heuristicCategory(
        item('mail:6', { fromAddress: 'no-reply@tool.example' }),
      ).category,
    ).toBe('bulk');
  });
});

describe('broadcast and answered-thread gating', () => {
  it('a broadcast addressed to the reader among many is a company update, not needsReply', () => {
    const wide = item('bc', {
      title: 'Weekly team update',
      signals: signals({
        unanswered: true,
        mentionsMe: true,
        broadcast: true,
        recipients: 20,
      }),
    });
    expect(heuristicCategory(wide).category).toBe('companyUpdates');
    expect(reconcileCategory(wide, 'needsReply')).toBe('companyUpdates');
    expect(reconcileCategory(wide, 'askedOfMe')).toBe('companyUpdates');
    expect(isActionEligible(wide)).toBe(false);
    expect(fallbackActionItems([wide])).toEqual([]);
  });

  it('request language in an answered thread is FYI, and the model may not call it askedOfMe', () => {
    const answered = item('done', {
      title: 'Could you review the budget?',
      signals: signals({ unanswered: false, mentionsMe: true }),
    });
    expect(heuristicCategory(answered).category).toBe('fyi');
    expect(reconcileCategory(answered, 'askedOfMe')).toBe('fyi');
    expect(reconcileCategory(answered, 'needsReply')).toBe('fyi');
    expect(isActionEligible({ ...answered, category: 'askedOfMe' })).toBe(
      false,
    );
  });

  it('open invitations and unanswered asks are action-eligible', () => {
    expect(
      isActionEligible(
        item('inv', {
          source: 'calendar',
          signals: signals({
            invitation: true,
            unanswered: true,
            mentionsMe: true,
          }),
        }),
      ),
    ).toBe(true);
    expect(
      isActionEligible(
        item('ask', {
          category: 'askedOfMe',
          signals: signals({ unanswered: true }),
        }),
      ),
    ).toBe(true);
  });

  it('priority order keeps an older open ask ahead of newer broadcasts and FYIs', () => {
    const ask = item('ask', {
      whenIso: '2026-10-24T08:00:00.000Z',
      signals: signals({ unanswered: true, mentionsMe: true }),
    });
    const post = item('post', {
      source: 'channel',
      whenIso: '2026-10-30T08:00:00.000Z',
      signals: signals({ broadcast: true }),
    });
    const fyi = item('fyi', { whenIso: '2026-10-30T07:00:00.000Z' });
    const waiting = item('wait', {
      signals: signals({ waitingOnOthers: true }),
    });
    expect(
      sortByDigestPriority([post, fyi, waiting, ask]).map((i) => i.id),
    ).toEqual(['ask', 'wait', 'fyi', 'post']);
    expect(digestPriority(ask)).toBeLessThan(digestPriority(post));
  });
});

describe('reconcileCategory', () => {
  it('overrides a model category that contradicts the signals', () => {
    const direct = item('mail:1', {
      signals: signals({ unanswered: true, mentionsMe: true }),
    });
    expect(reconcileCategory(direct, 'fyi')).toBe('needsReply');
    expect(reconcileCategory(direct, 'askedOfMe')).toBe('askedOfMe');
    const broadcast = item('mail:2', { signals: signals({ broadcast: true }) });
    expect(reconcileCategory(broadcast, 'needsReply')).toBe('companyUpdates');
    const invite = item('calendar:1', {
      signals: signals({ invitation: true }),
    });
    expect(reconcileCategory(invite, 'fyi')).toBe('scheduling');
  });
});

describe('classifyDigestItems', () => {
  beforeEach(() => vi.mocked(runUtilityJson).mockReset());

  it('uses model categories when they agree with the signals and flags nothing degraded', async () => {
    vi.mocked(runUtilityJson).mockResolvedValue({
      items: [
        {
          id: 'mail:1',
          category: 'askedOfMe',
          reason: 'asks for a budget review',
        },
        { id: 'mail:2', category: 'needsReply', reason: 'model got creative' },
        { id: 'mail:ghost', category: 'fyi', reason: 'unknown id ignored' },
      ],
    });
    const result = await classifyDigestItems([
      item('mail:1', {
        signals: signals({ unanswered: true, mentionsMe: true }),
      }),
      item('mail:2', { signals: signals({ broadcast: true }) }),
    ]);
    expect(result.degraded).toBe(false);
    const byId = new Map(result.items.map((entry) => [entry.id, entry]));
    expect(byId.get('mail:1')?.category).toBe('askedOfMe');
    expect(byId.get('mail:1')?.reason).toBe('asks for a budget review');
    // Broadcast cannot become needsReply; the heuristic reason replaces the model's.
    expect(byId.get('mail:2')?.category).toBe('companyUpdates');
    expect(byId.get('mail:2')?.reason).not.toBe('model got creative');
  });

  it('falls back to heuristics and reports degraded when the model is unavailable', async () => {
    vi.mocked(runUtilityJson).mockResolvedValue(null);
    const result = await classifyDigestItems([
      item('mail:1', {
        signals: signals({ unanswered: true, mentionsMe: true }),
      }),
    ]);
    expect(result.degraded).toBe(true);
    expect(result.items[0].category).toBe('needsReply');
  });
});

describe('extractDigestInsights', () => {
  beforeEach(() => vi.mocked(runUtilityJson).mockReset());

  it('drops action items the model invents for broadcasts and dedupes per source', async () => {
    vi.mocked(runUtilityJson).mockResolvedValue({
      themes: [
        {
          title: 'Atlas',
          summary: 'Weekly status',
          category: 'companyUpdates',
          itemIds: ['mail:2', 'nope'],
        },
      ],
      actionItems: [
        {
          title: 'Reply to Ana about the budget',
          sourceItemId: 'mail:1',
          askedBy: 'Ana',
          dueHint: 'Friday',
        },
        {
          title: 'Duplicate',
          sourceItemId: 'mail:1',
          askedBy: '',
          dueHint: '',
        },
        {
          title: 'Read the newsletter',
          sourceItemId: 'mail:2',
          askedBy: '',
          dueHint: '',
        },
      ],
    });
    const result = await extractDigestInsights([
      item('mail:1', {
        category: 'needsReply',
        signals: signals({ unanswered: true, mentionsMe: true }),
      }),
      item('mail:2', {
        category: 'companyUpdates',
        signals: signals({ broadcast: true }),
      }),
    ]);
    expect(result.actionItems).toHaveLength(1);
    expect(result.actionItems[0]).toMatchObject({
      sourceItemId: 'mail:1',
      askedBy: 'Ana',
      dueHint: 'Friday',
    });
    expect(result.themes).toEqual([
      expect.objectContaining({
        category: 'companyUpdates',
        itemIds: ['mail:2'],
      }),
    ]);
  });

  it('skips the model entirely when nothing is actionable', async () => {
    const result = await extractDigestInsights([
      item('mail:1', { category: 'fyi' }),
    ]);
    expect(runUtilityJson).not.toHaveBeenCalled();
    expect(result).toEqual({ themes: [], actionItems: [], degraded: false });
  });

  it('fallbackActionItems names the asker for each unanswered direct item', () => {
    const actions = fallbackActionItems([
      item('mail:1', {
        signals: signals({ unanswered: true, mentionsMe: true }),
      }),
      item('mail:2', { category: 'fyi' }),
    ]);
    expect(actions).toEqual([
      expect.objectContaining({
        sourceItemId: 'mail:1',
        title: 'Reply to Ana: Subject',
      }),
    ]);
  });
});
