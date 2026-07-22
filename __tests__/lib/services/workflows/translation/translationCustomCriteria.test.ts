import { runTranslationAssessment } from '@/lib/services/workflows/translation/translationOrchestrator';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const callStructured = vi.fn();

vi.mock(
  '@/lib/services/workflows/shared/workflowLlm',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/lib/services/workflows/shared/workflowLlm')
      >();
    return {
      ...original,
      createAzureClient: () => ({}),
      callStructured: (...args: unknown[]) => callStructured(...args),
    };
  },
);

function mockAssessment(criteriaIds: string[]) {
  callStructured.mockResolvedValueOnce({
    criteria: criteriaIds.map((id) => ({ id, rating: 4, summary: 'ok' })),
    edits: [],
    overallSummary: 'fine',
  });
}

const base = {
  sourceText: 'Take one tablet daily.',
  translation: 'Tomar un comprimido al día.',
  targetLanguage: 'Spanish',
  glossaryEntries: [],
};

describe('runTranslationAssessment custom criteria', () => {
  beforeEach(() => callStructured.mockReset());

  it('injects a custom rubric into the system prompt', async () => {
    mockAssessment(['accuracy', 'custom:abc']);

    await runTranslationAssessment({
      ...base,
      criterionIds: ['accuracy', 'custom:abc'],
      customById: new Map([
        ['custom:abc', { name: 'House style', rubric: 'Use the imperative' }],
      ]),
    });

    const systemPrompt = callStructured.mock.calls[0][0].system as string;
    expect(systemPrompt).toContain('House style: Use the imperative');
    // The built-in still comes through alongside it.
    expect(systemPrompt).toContain('Accuracy:');
  });

  it('keeps the requested order rather than the built-in list order', async () => {
    mockAssessment(['custom:abc', 'accuracy']);

    await runTranslationAssessment({
      ...base,
      criterionIds: ['custom:abc', 'accuracy'],
      customById: new Map([
        ['custom:abc', { name: 'House style', rubric: 'Use the imperative' }],
      ]),
    });

    const systemPrompt = callStructured.mock.calls[0][0].system as string;
    expect(systemPrompt.indexOf('House style')).toBeLessThan(
      systemPrompt.indexOf('Accuracy:'),
    );
  });

  it('omits a custom id with no definition instead of emitting a blank line', async () => {
    mockAssessment(['accuracy']);

    await runTranslationAssessment({
      ...base,
      criterionIds: ['accuracy', 'custom:orphan'],
      customById: new Map(),
    });

    const systemPrompt = callStructured.mock.calls[0][0].system as string;
    expect(systemPrompt).not.toContain('custom:orphan');
    expect(systemPrompt).not.toMatch(/^- *$/m);
  });

  it('puts custom ids in the schema enum so the model can rate them', async () => {
    mockAssessment(['custom:abc']);

    await runTranslationAssessment({
      ...base,
      criterionIds: ['custom:abc'],
      customById: new Map([
        ['custom:abc', { name: 'House style', rubric: 'Use the imperative' }],
      ]),
    });

    const schema = JSON.stringify(callStructured.mock.calls[0][0].schema);
    expect(schema).toContain('custom:abc');
  });

  it('returns ratings for a custom criterion', async () => {
    mockAssessment(['custom:abc']);

    const result = await runTranslationAssessment({
      ...base,
      criterionIds: ['custom:abc'],
      customById: new Map([
        ['custom:abc', { name: 'House style', rubric: 'Use the imperative' }],
      ]),
    });

    expect(result.criteria).toEqual([
      { criterionId: 'custom:abc', rating: 4, summary: 'ok' },
    ]);
  });
});
