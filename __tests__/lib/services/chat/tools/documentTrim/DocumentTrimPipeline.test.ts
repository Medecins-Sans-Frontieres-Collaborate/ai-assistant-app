import { Session } from 'next-auth';

import type {
  CodeInterpreterResult,
  CodeInterpreterTool,
} from '@/lib/services/chat/tools/CodeInterpreterTool';
import {
  chunkForPlanning,
  parseTrimStats,
  resolveTrimTarget,
  runDocumentTrim,
} from '@/lib/services/chat/tools/documentTrim/DocumentTrimPipeline';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const callStructuredMock = vi.fn();
vi.mock('@/lib/services/workflows/shared/workflowLlm', () => ({
  createAzureClient: vi.fn(() => ({})),
  callStructured: (...args: unknown[]) => callStructuredMock(...args),
}));

vi.mock('@/lib/services/workflows/shared/workflowModels', () => ({
  resolveWorkflowModelId: vi.fn(() => 'gpt-5.2'),
}));

// ~4 chars/token, no tiktoken load in tests.
vi.mock('@/lib/services/workflows/shared/textBudget', () => ({
  estimateTokens: vi.fn(async (text: string) => Math.ceil(text.length / 4)),
}));

const containersListMock = vi.fn();
const persistContainerFilesMock = vi.fn();
vi.mock('@/lib/services/chat/tools/CodeInterpreterTool', () => ({
  createFoundryOpenAIClient: vi.fn(async () => ({
    containers: { files: { list: containersListMock } },
  })),
  persistContainerFiles: (...args: unknown[]) =>
    persistContainerFilesMock(...args),
}));

const session = { user: { id: 'user-1' } } as unknown as Session;

const PLAN = {
  operations: [
    {
      action: 'delete',
      anchor: 'A'.repeat(45),
      paragraphCount: 2,
      replacement: [],
    },
  ],
  summary: 'Cut the literature review.',
};

function makeResult(
  overrides: Partial<CodeInterpreterResult> = {},
): CodeInterpreterResult {
  return {
    text: 'done',
    codeRuns: [
      {
        code: 'apply()',
        logs: 'TRIM_STATS: {"words_before": 18000, "words_after": 6100, "chars_before": 100000, "chars_after": 36000, "ops_total": 10, "ops_applied": 10, "ops_unmatched": 0}',
        status: 'completed',
      },
    ],
    generatedFiles: [
      {
        url: '/api/file/abc.docx',
        filename: 'manuscript_trimmed_6000words.docx',
        mime_type:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        is_image: false,
      },
    ],
    containerIds: ['cont_1'],
    durationMs: 1000,
    ...overrides,
  };
}

function makeTool(results: CodeInterpreterResult[]): {
  tool: CodeInterpreterTool;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn();
  for (const result of results) execute.mockResolvedValueOnce(result);
  return { tool: { execute } as unknown as CodeInterpreterTool, execute };
}

function baseParams(tool: CodeInterpreterTool) {
  return {
    document: {
      filename: 'manuscript.docx',
      data: Buffer.from('docx-bytes'),
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    format: 'docx' as const,
    extractedText: 'word '.repeat(18000).trim(),
    target: {
      kind: 'absolute',
      unit: 'words',
      target: 6000,
      approx: false,
    } as const,
    session,
    interpreterTool: tool,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callStructuredMock.mockResolvedValue(PLAN);
});

/** Extracts the numeric target from a Stage-2 instruction. */
function runDocumentTrimMockTarget(task: string): number {
  const match = task.match(/target\s+is\s+(\d+)\s+(?:words|characters)/);
  return match ? Number(match[1]) : NaN;
}

describe('resolveTrimTarget', () => {
  it('passes absolute targets through', () => {
    expect(
      resolveTrimTarget(
        { kind: 'absolute', unit: 'characters', target: 3000, approx: false },
        'irrelevant',
      ),
    ).toEqual({ unit: 'characters', target: 3000, approx: false });
  });

  it('resolves ratios against the extracted word count', () => {
    const text = 'word '.repeat(1000).trim();
    expect(
      resolveTrimTarget({ kind: 'ratio', keep: 0.5, approx: true }, text),
    ).toEqual({
      unit: 'words',
      target: 500,
      approx: true,
    });
  });
});

describe('parseTrimStats', () => {
  it('takes the last valid TRIM_STATS line and skips malformed ones', () => {
    const result = makeResult({
      codeRuns: [
        { code: null, logs: 'TRIM_STATS: {invalid json}', status: 'completed' },
        {
          code: null,
          logs: 'TRIM_STATS: {"words_before": 10, "words_after": 5, "chars_before": 50, "chars_after": 25, "ops_total": 1, "ops_applied": 1, "ops_unmatched": 0}',
          status: 'completed',
        },
      ],
    });
    expect(parseTrimStats(result)?.words_after).toBe(5);
  });

  it('falls back to the response text', () => {
    const result = makeResult({
      codeRuns: [],
      text: 'TRIM_STATS: {"words_before": 9, "words_after": 4, "chars_before": 1, "chars_after": 1, "ops_total": 1, "ops_applied": 1, "ops_unmatched": 0}',
    });
    expect(parseTrimStats(result)?.words_after).toBe(4);
  });

  it('returns null when nothing parseable exists', () => {
    expect(
      parseTrimStats(makeResult({ codeRuns: [], text: 'no stats' })),
    ).toBeNull();
  });
});

describe('chunkForPlanning', () => {
  it('returns a single chunk for small documents', async () => {
    expect(await chunkForPlanning('short document')).toEqual([
      'short document',
    ]);
  });

  it('splits long documents on headings into bounded chunks', async () => {
    const section = `# Heading\n${'body '.repeat(4000)}`;
    const text = Array.from({ length: 4 }, () => section).join('\n');
    const chunks = await chunkForPlanning(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n').length).toBeGreaterThanOrEqual(
      text.length - chunks.length,
    );
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(8000 * 4 + section.length);
    }
  });
});

describe('runDocumentTrim', () => {
  it('runs plan → execute with the plan mounted verbatim and returns counts', async () => {
    const { tool, execute } = makeTool([makeResult()]);

    const result = await runDocumentTrim(baseParams(tool));

    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0][0];
    expect(call.verbatimTask).toBe(true);
    expect(call.inputFiles).toHaveLength(2);
    expect(call.inputFiles[0].filename).toBe('manuscript.docx');
    expect(call.inputFiles[1].filename).toBe('plan.json');
    expect(JSON.parse(call.inputFiles[1].data.toString())).toEqual({
      ...PLAN,
      excludedSectionHeadings: [],
    });
    expect(call.task).toContain('manuscript_trimmed_6000words.docx');
    expect(call.task).toContain('6000 words');

    expect(result.retried).toBe(false);
    expect(result.countBefore).toBe(18000);
    expect(result.countAfter).toBe(6100);
    expect(result.text).toContain('Document trimmed');
    expect(result.text).toContain('Cut the literature review.');
  });

  it('retries once on overshoot, re-executing from the ORIGINAL bytes', async () => {
    const overshoot = makeResult({
      codeRuns: [
        {
          code: null,
          logs: 'TRIM_STATS: {"words_before": 18000, "words_after": 9000, "chars_before": 1, "chars_after": 1, "ops_total": 10, "ops_applied": 10, "ops_unmatched": 0}',
          status: 'completed',
        },
      ],
    });
    const { tool, execute } = makeTool([overshoot, makeResult()]);

    const result = await runDocumentTrim(baseParams(tool));

    expect(execute).toHaveBeenCalledTimes(2);
    // Both executions receive the original document bytes.
    for (const call of execute.mock.calls) {
      expect(call[0].inputFiles[0].data.toString()).toBe('docx-bytes');
    }
    // The corrective planning round carries feedback about the miss.
    const feedbackCall = callStructuredMock.mock.calls.find(([options]) =>
      (options as { user: string }).user.includes(
        'previous plan achieved 9000',
      ),
    );
    expect(feedbackCall).toBeDefined();
    expect(result.retried).toBe(true);
    expect(result.countAfter).toBe(6100);
  });

  it('skips the retry when the remaining budget is too small', async () => {
    const overshoot = makeResult({
      codeRuns: [
        {
          code: null,
          logs: 'TRIM_STATS: {"words_before": 18000, "words_after": 9000, "chars_before": 1, "chars_after": 1, "ops_total": 10, "ops_applied": 10, "ops_unmatched": 0}',
          status: 'completed',
        },
      ],
    });
    const { tool, execute } = makeTool([overshoot]);

    const result = await runDocumentTrim({
      ...baseParams(tool),
      budgetMs: 1_000, // < RETRY_MIN_BUDGET_MS remaining from the start
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.retried).toBe(false);
    expect(result.countAfter).toBe(9000);
    expect(result.text).toContain('missed the target');
  });

  it('ships the first-pass file when the corrective pass fails', async () => {
    // Regression: a failed/overrunning retry once destroyed a perfectly
    // usable first-pass file by blowing the stage timeout.
    const undershoot = makeResult({
      codeRuns: [
        {
          code: null,
          logs: 'TRIM_STATS: {"words_before": 18000, "words_after": 3797, "chars_before": 1, "chars_after": 1, "ops_total": 10, "ops_applied": 10, "ops_unmatched": 0}',
          status: 'completed',
        },
      ],
    });
    const execute = vi.fn();
    execute.mockResolvedValueOnce(undershoot);
    execute.mockRejectedValueOnce(new Error('sandbox exploded on retry'));
    const tool = { execute } as unknown as CodeInterpreterTool;

    const result = await runDocumentTrim(baseParams(tool));

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.retried).toBe(true);
    expect(result.countAfter).toBe(3797);
    expect(result.generatedFiles.length).toBeGreaterThan(0);
    expect(result.text).toContain('missed the target');
  });

  it('retries when unmatched operations exceed 20%', async () => {
    const unmatched = makeResult({
      codeRuns: [
        {
          code: null,
          logs: 'TRIM_STATS: {"words_before": 18000, "words_after": 6100, "chars_before": 1, "chars_after": 1, "ops_total": 10, "ops_applied": 7, "ops_unmatched": 3}',
          status: 'completed',
        },
      ],
    });
    const { tool, execute } = makeTool([unmatched, makeResult()]);

    const result = await runDocumentTrim(baseParams(tool));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.retried).toBe(true);
  });

  it('recovers an uncited output file from the container listing', async () => {
    const uncited = makeResult({ generatedFiles: [] });
    containersListMock.mockResolvedValue(
      (async function* () {
        yield {
          id: 'file_1',
          path: '/mnt/data/manuscript_trimmed_6000words.docx',
        };
      })(),
    );
    persistContainerFilesMock.mockResolvedValue([
      {
        url: '/api/file/def.docx',
        filename: 'manuscript_trimmed_6000words.docx',
        mime_type: 'application/octet-stream',
        is_image: false,
      },
    ]);
    // Recovery happens on both attempts; second attempt also uncited so the
    // pipeline must succeed via recovery alone.
    const { tool } = makeTool([uncited]);

    const result = await runDocumentTrim(baseParams(tool));

    expect(persistContainerFilesMock).toHaveBeenCalledWith(
      expect.anything(),
      [
        {
          containerId: 'cont_1',
          fileId: 'file_1',
          filename: 'manuscript_trimmed_6000words.docx',
        },
      ],
      session,
    );
    expect(
      result.generatedFiles.some((f) => f.url === '/api/file/def.docx'),
    ).toBe(true);
  });

  it('throws honestly when no output file can be recovered', async () => {
    const uncited = makeResult({ generatedFiles: [], containerIds: [] });
    const { tool } = makeTool([uncited, uncited]);

    await expect(runDocumentTrim(baseParams(tool))).rejects.toThrow(
      /no output file/,
    );
  });

  it('excludes protected sections from planning, counts, and edits', async () => {
    const { tool, execute } = makeTool([makeResult()]);
    const body = 'word '.repeat(1000).trim();
    const references = Array.from(
      { length: 50 },
      (_, i) => `${i + 1}. Author ${i}. A reference entry with many words.`,
    ).join('\n');

    const result = await runDocumentTrim({
      ...baseParams(tool),
      extractedText: `# Introduction\n${body}\n# References\n${references}`,
      // Ratio must resolve against the COUNTABLE body (~1002 words incl.
      // heading), not body + references.
      target: { kind: 'ratio', keep: 0.5, approx: true },
    });

    // The planner never sees the reference entries.
    for (const [options] of callStructuredMock.mock.calls) {
      expect((options as { user: string }).user).not.toContain(
        'A reference entry',
      );
    }
    // Ratio target computed on countable words only (~501, not ~751+).
    const call = execute.mock.calls[0][0];
    const planPayload = JSON.parse(call.inputFiles[1].data.toString());
    expect(planPayload.excludedSectionHeadings).toEqual(['References']);
    const target = runDocumentTrimMockTarget(call.task);
    expect(target).toBeLessThan(600);
    expect(target).toBeGreaterThan(400);

    expect(result.excludedSections).toEqual(['References']);
    expect(result.text).toContain('left untouched: References');
  });

  it('resolves ratio targets from the extracted text before planning', async () => {
    const { tool, execute } = makeTool([
      makeResult({
        codeRuns: [
          {
            code: null,
            logs: 'TRIM_STATS: {"words_before": 18000, "words_after": 9000, "chars_before": 1, "chars_after": 1, "ops_total": 5, "ops_applied": 5, "ops_unmatched": 0}',
            status: 'completed',
          },
        ],
        generatedFiles: [
          {
            url: '/api/file/ghi.docx',
            filename: 'manuscript_trimmed_9000words.docx',
            mime_type: 'application/octet-stream',
            is_image: false,
          },
        ],
      }),
    ]);

    const result = await runDocumentTrim({
      ...baseParams(tool),
      target: { kind: 'ratio', keep: 0.5, approx: true },
    });

    expect(execute.mock.calls[0][0].task).toContain('9000 words');
    expect(result.targetCount).toBe(9000);
    expect(result.retried).toBe(false);
  });
});
