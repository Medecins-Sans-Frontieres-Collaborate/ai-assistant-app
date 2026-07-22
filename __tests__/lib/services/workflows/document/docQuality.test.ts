import { runDocumentAssessment } from '@/lib/services/workflows/document/documentOrchestrator';
import {
  buildDocAssessmentSystemPrompt,
  buildQualityGuidanceBlock,
  buildSpecBlock,
  buildToneBlock,
} from '@/lib/services/workflows/document/prompts';
import { buildAssessmentSchema } from '@/lib/services/workflows/shared/assessmentSchema';

import { DocumentSpec } from '@/types/workflow';

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

const spec: DocumentSpec = {
  id: 's1',
  name: 'SitRep',
  sections: [
    { heading: 'Overview', guidance: 'Two paragraphs max', required: true },
    { heading: 'Needs', required: true },
    { heading: 'Annex', required: false },
  ],
  generalGuidance: 'Keep it factual.',
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z',
};

describe('document prompt blocks', () => {
  it('renders spec sections numbered, ordered, with required flags', () => {
    const block = buildSpecBlock(spec);
    expect(block).toContain('1. Overview (required) — Two paragraphs max');
    expect(block).toContain('2. Needs (required)');
    expect(block).toContain('3. Annex (optional)');
    expect(block).toContain('General guidance: Keep it factual.');
    expect(block.indexOf('Overview')).toBeLessThan(block.indexOf('Needs'));
  });

  it('renders tone and guidance blocks', () => {
    expect(
      buildToneBlock({ name: 'Field voice', voiceRules: 'Short sentences.' }),
    ).toContain('VOICE AND TONE RULES ("Field voice")');
    expect(
      buildQualityGuidanceBlock([{ name: 'Brand', rubric: 'No superlatives' }]),
    ).toContain('- Brand: No superlatives');
    expect(buildQualityGuidanceBlock([])).toBe('');
  });

  it('assessor prompt is language-general and carries detected context', () => {
    const withLanguage = buildDocAssessmentSystemPrompt(['rubric'], {
      language: 'French',
      conventionNotes: 'European French orthography',
    });
    expect(withLanguage).toContain('written in French');
    expect(withLanguage).toContain('European French orthography');
    expect(withLanguage).toContain("document's own language");

    const plain = buildDocAssessmentSystemPrompt(['rubric'], {});
    expect(plain).not.toContain('written in');
    expect(plain).toContain('never assume English');
    expect(plain).toContain('markdown');
  });

  it('selection scope constrains ratings and edits to the excerpt', () => {
    const scoped = buildDocAssessmentSystemPrompt(['rubric'], {
      hasSelection: true,
    });
    expect(scoped).toContain('highlighted excerpt');
    expect(scoped).toContain("DOCUMENT's markdown");
    const unscoped = buildDocAssessmentSystemPrompt(['rubric'], {});
    expect(unscoped).not.toContain('highlighted excerpt');
  });
});

describe('assessment schema with custom ids', () => {
  it('enum lists exactly the requested ids including custom ones', () => {
    const schema = buildAssessmentSchema(['grammarSpelling', 'custom:abc']) as {
      properties: {
        criteria: { items: { properties: { id: { enum: string[] } } } };
        edits: { items: { properties: { criterion: { enum: string[] } } } };
      };
    };
    expect(schema.properties.criteria.items.properties.id.enum).toEqual([
      'grammarSpelling',
      'custom:abc',
    ]);
    expect(schema.properties.edits.items.properties.criterion.enum).toContain(
      'custom:abc',
    );
  });
});

describe('runDocumentAssessment sanitation', () => {
  beforeEach(() => callStructured.mockReset());

  it('injects custom rubrics, clamps ratings, filters bad edits', async () => {
    callStructured.mockResolvedValueOnce({
      criteria: [
        { id: 'grammarSpelling', rating: 9, summary: 'ok' },
        { id: 'custom:abc', rating: 0, summary: 'meh' },
        { id: 'notRequested', rating: 3, summary: 'x' },
      ],
      edits: [
        {
          criterion: 'grammarSpelling',
          before: 'teh',
          after: 'the',
          reason: 'typo',
          severity: 'minor',
        },
        {
          criterion: 'grammarSpelling',
          before: '',
          after: 'x',
          reason: '',
          severity: 'minor',
        },
        {
          criterion: 'grammarSpelling',
          before: 'same',
          after: 'same',
          reason: '',
          severity: 'minor',
        },
        {
          criterion: 'notRequested',
          before: 'a',
          after: 'b',
          reason: '',
          severity: 'major',
        },
      ],
      overallSummary: 'fine',
    });

    const result = await runDocumentAssessment({
      docMarkdown: 'teh document',
      criterionIds: ['grammarSpelling', 'custom:abc'],
      customById: new Map([
        ['custom:abc', { name: 'Brand', rubric: 'No superlatives' }],
      ]),
    });

    // Custom rubric reached the system prompt.
    const systemPrompt = callStructured.mock.calls[0][0].system as string;
    expect(systemPrompt).toContain('Brand: No superlatives');

    expect(result.criteria).toHaveLength(2);
    expect(result.criteria[0].rating).toBe(5); // clamped from 9
    expect(result.criteria[1].rating).toBe(1); // clamped from 0
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].before).toBe('teh');
  });
});
