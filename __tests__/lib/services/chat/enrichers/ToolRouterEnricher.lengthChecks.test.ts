/**
 * Length requests measured before anything runs, and interpreter staging
 * that skips (and reports) a file that does not fit instead of dropping
 * every file after it.
 */
import { ToolRouterEnricher } from '@/lib/services/chat/enrichers/ToolRouterEnricher';

import { loadDocument } from '@/lib/utils/server/file/fileHandling';

import { Message } from '@/types/chat';

import { createTestChatContext } from '../testUtils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { blobGetMock } = vi.hoisted(() => ({ blobGetMock: vi.fn() }));

vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({ get: blobGetMock }),
}));
vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: () => 'user-1',
}));
vi.mock('@/lib/services/limits/toolBudget', () => ({
  consumeToolBudget: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  loadDocument: vi.fn(),
}));
// A 10-byte staging budget keeps the fixtures small; the skip logic is the
// same at 100MB.
vi.mock(
  '@/lib/services/chat/tools/interpreterInputRefs',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/lib/services/chat/tools/interpreterInputRefs')
    >()),
    INTERPRETER_STAGING_MAX_BYTES: 10,
  }),
);

function attaching(...files: Array<[string, string]>): Message[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'go' },
        ...files.map(([id, name]) => ({
          type: 'file_url',
          url: `/api/file/${id}`,
          originalFilename: name,
        })),
      ],
    } as unknown as Message,
  ];
}

const words = (n: number) => 'word '.repeat(n).trim();

describe('ToolRouterEnricher — length checks and staging', () => {
  let enricher: ToolRouterEnricher;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    enricher = new ToolRouterEnricher({
      determineTool: vi.fn(),
      classifyDocumentTrim: vi.fn(),
    } as any);
  });

  it('skips a file over the staging budget and still mounts the ones after it', async () => {
    const sizes: Record<string, number> = {
      'a.csv': 4,
      'big.csv': 9,
      'c.csv': 4,
    };
    blobGetMock.mockImplementation(async (path: string) =>
      Buffer.alloc(sizes[path.split('/').pop()!]),
    );
    const context = createTestChatContext({
      messages: attaching(
        ['a.csv', 'A.csv'],
        ['big.csv', 'Big.csv'],
        ['c.csv', 'C.csv'],
      ),
    });
    const staged = await (enricher as any).stageInterpreterInputFiles(context);
    expect(staged.files.map((f: { filename: string }) => f.filename)).toEqual([
      'A.csv',
      'C.csv',
    ]);
    expect(staged.unmounted).toEqual(['Big.csv']);
    expect(
      (ToolRouterEnricher as any).unmountedFilesNote(staged.unmounted),
    ).toContain('Big.csv');
    expect((ToolRouterEnricher as any).unmountedFilesNote([])).toBeUndefined();
  });

  describe('describeExpansionRequest', () => {
    const target = {
      kind: 'absolute',
      unit: 'words',
      target: 500,
      approx: false,
      direction: 'expand',
    } as const;

    function contextWith(inlineText: string) {
      blobGetMock.mockResolvedValue(Buffer.from('docx'));
      return createTestChatContext({
        messages: attaching(['d.docx', 'Draft.docx']),
        processedContent: {
          inlineFiles: [{ filename: 'Draft.docx', content: inlineText }],
        },
      } as any);
    }

    it('says the document already meets the target instead of padding it', async () => {
      const note = await (enricher as any).describeExpansionRequest(
        contextWith(words(500)),
        'Draft.docx',
        target,
      );
      expect(note).toContain('already meets');
      expect(note).toContain('Do not pad');
    });

    it('asks for the measured difference when the document is short', async () => {
      const note = await (enricher as any).describeExpansionRequest(
        contextWith(words(300)),
        'Draft.docx',
        target,
      );
      expect(note).toContain('about 200 words');
      expect(note).not.toContain('already meets');
    });
  });

  it('measures the full document, never an inline excerpt', async () => {
    blobGetMock.mockResolvedValue(Buffer.from('docx'));
    vi.mocked(loadDocument).mockResolvedValue(words(900));
    const context = createTestChatContext({
      messages: attaching(['d.docx', 'Draft.docx']),
      processedContent: {
        inlineFiles: [
          { filename: 'Draft.docx', content: words(100), isExcerpt: true },
        ],
      },
    } as any);
    const note = await (enricher as any).describeExpansionRequest(
      context,
      'Draft.docx',
      { kind: 'absolute', unit: 'words', target: 1000, approx: false },
    );
    expect(loadDocument).toHaveBeenCalledTimes(1);
    expect(note).toContain('about 900 words');
  });
});

/**
 * After the sub-tool interpreter has produced the requested file, the
 * answering model must present it, not write a second analysis from its
 * excerpts (reproduced 2026-11-07 with Mistral-Large-3).
 */
describe('ToolRouterEnricher — interpreter handoff', () => {
  const enricher = new ToolRouterEnricher({
    determineTool: vi.fn(),
    classifyDocumentTrim: vi.fn(),
  } as any);
  const build = (generatedFiles: Array<{ filename: string }>) =>
    (enricher as any).buildInterpreterContext({
      text: 'Rapport Word généré.',
      codeRuns: [],
      generatedFiles,
      containerIds: [],
      durationMs: 1,
    }) as string;

  it('marks a generated deliverable as complete and forbids re-analysis', () => {
    const note = build([{ filename: 'revue.docx' }]);
    expect(note).toContain('revue.docx');
    expect(note).toContain('it is complete');
    expect(note).toContain('Do not redo');
  });

  it('adds nothing about deliverables when no file was produced', () => {
    expect(build([])).not.toContain('it is complete');
  });
});

/**
 * After the sub-tool interpreter read the files in full, the answering
 * model gets excerpts plus the reader tools — but only when it can use
 * those tools; otherwise the full text stays inline.
 */
describe('ToolRouterEnricher — excerpts after the interpreter read the files', () => {
  const big = 'row\n'.repeat(30_000);
  const contextFor = (model: Record<string, unknown>) =>
    createTestChatContext({
      model,
      processedContent: {
        inlineFiles: [
          { filename: 'Rapport_2021.pdf', content: big },
          { filename: 'Cadre.docx', content: 'short framework' },
        ],
      },
    } as any);
  const excerpt = (context: unknown, names: string[]) =>
    (ToolRouterEnricher as any).excerptReadAttachments(context, names);

  it('excerpts large mounted files for a tool-capable model and keeps their text', () => {
    const result = excerpt(
      contextFor({
        id: 'claude-sonnet-5',
        sdk: 'anthropic-foundry',
        supportsTools: true,
      }),
      ['Rapport_2021.pdf', 'Cadre.docx'],
    );
    const [report, framework] = result.processedContent.inlineFiles;
    expect(report.isExcerpt).toBe(true);
    expect(report.content).toContain('search_attachment');
    expect(framework.content).toBe('short framework');
    expect(result.attachmentTexts).toEqual({ 'Rapport_2021.pdf': big });
  });

  it('leaves the full text inline for a model without tools', () => {
    const context = contextFor({ id: 'Mistral-Large-3', sdk: 'openai' });
    expect(excerpt(context, ['Rapport_2021.pdf'])).toBe(context);
  });

  it('does not touch files the sandbox did not receive', () => {
    const context = contextFor({
      id: 'claude-sonnet-5',
      sdk: 'anthropic-foundry',
      supportsTools: true,
    });
    expect(excerpt(context, ['other.xlsx'])).toBe(context);
  });
});
