import { ActiveFileInjector } from '@/lib/services/chat/processors/ActiveFileInjector';

import { IMAGE_TOKENS_HIGH_DETAIL } from '@/lib/utils/server/chat/chat';

import { ActiveFile, ImageMessageContent } from '@/types/chat';
import { OpenAIModelID } from '@/types/openai';

import { createTestChatContext } from '../testUtils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/server/blob/blob', () => ({
  getBlobBase64String: vi.fn(
    async (_userId, filename) => `data:image/png;base64,STUB_${filename}`,
  ),
}));

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

const makeImage = (
  id: string,
  opts: { pinned?: boolean } = {},
): ActiveFile => ({
  id,
  url: `/api/file/${id}.png`,
  originalFilename: `${id}.png`,
  addedAt: NOW,
  sourceMessageId: 'msg-1',
  status: 'ready',
  pinned: opts.pinned ?? true,
  processedContent: {
    type: 'image',
    content: '',
    tokenEstimate: 0,
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

  describe('pinned image re-injection', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    const visionContext = (overrides: Partial<{ messages: any[] }> = {}) => {
      const ctx = createTestChatContext({
        model: { id: OpenAIModelID.GPT_5_2, maxLength: 128_000 },
        messages: overrides.messages ?? [
          {
            role: 'user',
            content: [{ type: 'text', text: 'describe this' }],
          },
        ],
      });
      ctx.modelId = OpenAIModelID.GPT_5_2;
      return ctx;
    };

    it('appends image_url block + adds 765 tokens when vision + setting on', async () => {
      const ctx = visionContext();
      ctx.autoInjectPinnedImages = true;
      ctx.activeFiles = [makeImage('img1', { pinned: true })];

      const result = await new ActiveFileInjector().execute(ctx);

      expect(result.activeFilesTokensConsumedThisTurn).toBe(
        IMAGE_TOKENS_HIGH_DETAIL,
      );
      const last =
        result.enrichedMessages![result.enrichedMessages!.length - 1];
      expect(Array.isArray(last.content)).toBe(true);
      const imageBlocks = (last.content as any[]).filter(
        (c) => c.type === 'image_url',
      ) as ImageMessageContent[];
      expect(imageBlocks).toHaveLength(1);
      expect(imageBlocks[0].image_url.url).toMatch(/^data:image\/png;base64,/);
      expect(imageBlocks[0].image_url.detail).toBe('auto');
    });

    it('skips injection + charges nothing when setting off', async () => {
      const ctx = visionContext();
      ctx.autoInjectPinnedImages = false;
      ctx.activeFiles = [makeImage('img1', { pinned: true })];

      const result = await new ActiveFileInjector().execute(ctx);

      expect(result.activeFilesTokensConsumedThisTurn).toBe(0);
      // No enrichedMessages mutation since nothing was added
      expect(result.enrichedMessages).toBeUndefined();
    });

    it('skips injection for unpinned images even on vision models', async () => {
      const ctx = visionContext();
      ctx.autoInjectPinnedImages = true;
      ctx.activeFiles = [makeImage('img1', { pinned: false })];

      const result = await new ActiveFileInjector().execute(ctx);

      expect(result.activeFilesTokensConsumedThisTurn).toBe(0);
      expect(result.enrichedMessages).toBeUndefined();
    });

    it('preserves text-indicator path for non-vision models regardless of setting', async () => {
      const ctx = createTestChatContext({
        model: { id: OpenAIModelID.DEEPSEEK_V3_1, maxLength: 128_000 },
        messages: [{ role: 'user', content: 'analyse this' }],
      });
      ctx.modelId = OpenAIModelID.DEEPSEEK_V3_1;
      ctx.autoInjectPinnedImages = false; // setting off — indicator still appears
      ctx.activeFiles = [makeImage('img1', { pinned: true })];

      const result = await new ActiveFileInjector().execute(ctx);

      const last =
        result.enrichedMessages![result.enrichedMessages!.length - 1];
      expect(typeof last.content).toBe('string');
      expect(last.content as string).toContain('Active images referenced');
      // Indicator is text only — no image-token cost
      expect(result.activeFilesTokensConsumedThisTurn).toBe(0);
    });

    it('upgrades string-content user message to array on injection', async () => {
      const ctx = visionContext({
        messages: [{ role: 'user', content: 'plain string content' }],
      });
      ctx.autoInjectPinnedImages = true;
      ctx.activeFiles = [makeImage('img1', { pinned: true })];

      const result = await new ActiveFileInjector().execute(ctx);

      const last =
        result.enrichedMessages![result.enrichedMessages!.length - 1];
      expect(Array.isArray(last.content)).toBe(true);
      const arr = last.content as any[];
      expect(arr[0]).toEqual({ type: 'text', text: 'plain string content' });
      expect(arr[arr.length - 1].type).toBe('image_url');
    });

    it('combines pinned image injection with pinned text file in same turn', async () => {
      const ctx = visionContext();
      ctx.autoInjectPinnedImages = true;
      ctx.activeFiles = [
        makeFile('doc', 10_000, { pinned: true }),
        makeImage('img1', { pinned: true }),
      ];

      const result = await new ActiveFileInjector().execute(ctx);

      // Text file goes to system prompt; image goes to last user message.
      expect(result.systemPrompt).toContain('Active Files Context');
      expect(result.activeFilesTokensConsumedThisTurn).toBe(
        10_000 + IMAGE_TOKENS_HIGH_DETAIL,
      );
      const last =
        result.enrichedMessages![result.enrichedMessages!.length - 1];
      const imageBlocks = (last.content as any[]).filter(
        (c) => c.type === 'image_url',
      );
      expect(imageBlocks).toHaveLength(1);
    });

    it('still injects on Anthropic vision models — handler-level filter is a separate concern', async () => {
      // Documenting current behavior: the injector treats Anthropic vision
      // models the same as any other vision model. AnthropicHandler will
      // strip the image content downstream, but that's not the injector's
      // job to know about. If/when AnthropicHandler grows real image
      // support, this test stays green; if Anthropic ever needs to be
      // skipped at the injector level, this test will guide that change.
      const ctx = createTestChatContext({
        model: {
          id: OpenAIModelID.CLAUDE_SONNET_4_6,
          maxLength: 200_000,
          provider: 'anthropic',
        },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      });
      ctx.modelId = OpenAIModelID.CLAUDE_SONNET_4_6;
      ctx.autoInjectPinnedImages = true;
      ctx.activeFiles = [makeImage('img1', { pinned: true })];

      const result = await new ActiveFileInjector().execute(ctx);

      expect(result.activeFilesTokensConsumedThisTurn).toBe(
        IMAGE_TOKENS_HIGH_DETAIL,
      );
      const last =
        result.enrichedMessages![result.enrichedMessages!.length - 1];
      const imageBlocks = (last.content as any[]).filter(
        (c) => c.type === 'image_url',
      );
      expect(imageBlocks).toHaveLength(1);
    });

    it('passes through data: URLs without re-fetching', async () => {
      const ctx = visionContext();
      ctx.autoInjectPinnedImages = true;
      const file = makeImage('img1', { pinned: true });
      file.url = 'data:image/png;base64,ALREADY_INLINED';
      ctx.activeFiles = [file];

      const result = await new ActiveFileInjector().execute(ctx);

      const last =
        result.enrichedMessages![result.enrichedMessages!.length - 1];
      const imageBlocks = (last.content as any[]).filter(
        (c) => c.type === 'image_url',
      ) as ImageMessageContent[];
      expect(imageBlocks[0].image_url.url).toBe(
        'data:image/png;base64,ALREADY_INLINED',
      );
    });
  });
});
