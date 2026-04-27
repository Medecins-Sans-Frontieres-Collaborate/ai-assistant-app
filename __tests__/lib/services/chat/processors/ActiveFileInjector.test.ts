import { ActiveFileInjector } from '@/lib/services/chat/processors/ActiveFileInjector';

import { ActiveFile } from '@/types/chat';

import { createTestChatContext } from '../testUtils';

import { describe, expect, it } from 'vitest';

const NOW = '2026-01-01T00:00:00.000Z';

const makeFile = (
  id: string,
  tokens: number,
  opts: { pinned?: boolean; addedAt?: string; lastUsedAt?: string } = {},
): ActiveFile => ({
  id,
  url: `https://files/${id}`,
  originalFilename: `${id}.txt`,
  addedAt: opts.addedAt ?? NOW,
  lastUsedAt: opts.lastUsedAt,
  sourceMessageId: 'msg-1',
  status: 'ready',
  pinned: opts.pinned ?? false,
  processedContent: {
    type: 'document',
    content: 'x'.repeat(tokens * 4),
    tokenEstimate: tokens,
    processedAt: NOW,
  },
});

describe('ActiveFileInjector', () => {
  it('reports dropped file IDs when total exceeds per-turn budget', async () => {
    // Mid-tier 128k/16k model gives a 33.6k per-turn budget. Two 20k files
    // (total 40k) overflow it, so exactly one must be dropped per turn.
    const context = createTestChatContext({
      messages: [{ role: 'user', content: 'hello' }],
    });
    context.activeFiles = [
      makeFile('a', 20_000, { addedAt: '2026-01-01T00:00:00.000Z' }),
      makeFile('b', 20_000, { addedAt: '2026-01-02T00:00:00.000Z' }),
    ];

    const injector = new ActiveFileInjector();
    const result = await injector.execute(context);

    expect(result.activeFilesDroppedThisTurn).toHaveLength(1);
    expect(result.activeFilesTokensConsumedThisTurn).toBe(20_000);
  });

  it('stamps lastUsedAt only on selected files, not on dropped ones', async () => {
    const context = createTestChatContext({
      messages: [{ role: 'user', content: 'hello' }],
    });
    const fileAOriginal = '2026-01-01T00:00:00.000Z';
    const fileBOriginal = '2026-01-02T00:00:00.000Z';
    context.activeFiles = [
      makeFile('a', 20_000, { lastUsedAt: fileAOriginal }),
      makeFile('b', 20_000, { lastUsedAt: fileBOriginal }),
    ];

    const before = Date.now();
    const result = await new ActiveFileInjector().execute(context);
    const after = Date.now();

    const fileA = result.activeFiles!.find((f) => f.id === 'a')!;
    const fileB = result.activeFiles!.find((f) => f.id === 'b')!;

    // The more-recent file (B) is selected; its lastUsedAt is bumped to ~now.
    // The dropped file (A) keeps its original timestamp so the next turn's
    // sort can rotate it back into context.
    expect(fileA.lastUsedAt).toBe(fileAOriginal);

    const fileBTime = new Date(fileB.lastUsedAt!).getTime();
    expect(fileBTime).toBeGreaterThanOrEqual(before);
    expect(fileBTime).toBeLessThanOrEqual(after + 1);
    expect(result.activeFilesDroppedThisTurn).toEqual(['a']);
  });

  it('rotates dropped files back into context on the next turn', async () => {
    // The headline regression this whole feature exists to fix: without
    // lastUsedAt being updated on injection, the first-uploaded file sorts
    // last forever and is dropped every single turn. With the stamp, turn
    // N+1 sees the previously-dropped file as more recent and selects it.
    const context = createTestChatContext({
      messages: [{ role: 'user', content: 'hello' }],
    });
    context.activeFiles = [
      makeFile('a', 20_000, { lastUsedAt: '2026-01-01T00:00:00.000Z' }),
      makeFile('b', 20_000, { lastUsedAt: '2026-01-02T00:00:00.000Z' }),
    ];

    // Turn 1: B is more recent → B selected, A dropped.
    const turn1 = await new ActiveFileInjector().execute(context);
    expect(turn1.activeFilesDroppedThisTurn).toEqual(['a']);

    // Feed turn 1's updated activeFiles back in for turn 2 (matches the
    // real flow where the client persists the stamps via SSE updates).
    const turn2Context = {
      ...context,
      activeFiles: turn1.activeFiles,
    };

    // Turn 2: B was just stamped, so A's original timestamp is now older
    // than B's stamped timestamp. A sorts first by recency, so A is
    // selected and B becomes the dropped file. Rotation works.
    const turn2 = await new ActiveFileInjector().execute(turn2Context);
    expect(turn2.activeFilesDroppedThisTurn).toEqual(['b']);
    expect(turn2.activeFilesTokensConsumedThisTurn).toBe(20_000);
  });

  it('emits no dropped IDs when everything fits the budget', async () => {
    const context = createTestChatContext({
      messages: [{ role: 'user', content: 'hello' }],
    });
    context.activeFiles = [makeFile('a', 5_000), makeFile('b', 5_000)];

    const result = await new ActiveFileInjector().execute(context);
    expect(result.activeFilesDroppedThisTurn).toEqual([]);
    expect(result.activeFilesTokensConsumedThisTurn).toBe(10_000);
  });
});
