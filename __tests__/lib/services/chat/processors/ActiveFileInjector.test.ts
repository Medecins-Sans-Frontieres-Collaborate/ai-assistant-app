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

    // Equal-size files tie in `recent` and `sizeAsc` (1 file each); the
    // selector picks `sizeAsc` on ties, and its LRU tie-break picks the
    // older-stamped file (A) so the previously-dropped file rotates in.
    // A's stamp is bumped to ~now; B keeps its original timestamp so it
    // can rotate back next turn.
    const fileATime = new Date(fileA.lastUsedAt!).getTime();
    expect(fileATime).toBeGreaterThanOrEqual(before);
    expect(fileATime).toBeLessThanOrEqual(after + 1);
    expect(fileB.lastUsedAt).toBe(fileBOriginal);
    expect(result.activeFilesDroppedThisTurn).toEqual(['b']);
  });

  it('rotates dropped files back into context on the next turn', async () => {
    // The headline regression this whole feature exists to fix: without
    // lastUsedAt being updated on injection, the same file is dropped every
    // turn forever. With the stamp + LRU tie-break in sizeAsc, the file that
    // was dropped on turn N gets a turn in context on turn N+1.
    const context = createTestChatContext({
      messages: [{ role: 'user', content: 'hello' }],
    });
    context.activeFiles = [
      makeFile('a', 20_000, { lastUsedAt: '2026-01-01T00:00:00.000Z' }),
      makeFile('b', 20_000, { lastUsedAt: '2026-01-02T00:00:00.000Z' }),
    ];

    // Turn 1: sizeAsc tie + LRU picks A (older stamp). B is dropped.
    const turn1 = await new ActiveFileInjector().execute(context);
    expect(turn1.activeFilesDroppedThisTurn).toEqual(['b']);

    // Feed turn 1's updated activeFiles back in for turn 2 (matches the
    // real flow where the client persists the stamps via SSE updates).
    const turn2Context = {
      ...context,
      activeFiles: turn1.activeFiles,
    };

    // Turn 2: A was just stamped, so B's original timestamp is now older
    // than A's stamped timestamp. sizeAsc + LRU picks B; rotation works.
    const turn2 = await new ActiveFileInjector().execute(turn2Context);
    expect(turn2.activeFilesDroppedThisTurn).toEqual(['a']);
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
