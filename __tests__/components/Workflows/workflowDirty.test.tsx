import { TranslationWorkflowState } from '@/types/workflow';

import { createInitialWorkflowState } from '@/components/Workflows/initialState';
import { isWorkflowStatePristine } from '@/components/Workflows/workflowDirty';

import { describe, expect, it } from 'vitest';

describe('isWorkflowStatePristine', () => {
  it('treats a missing state as pristine', () => {
    expect(isWorkflowStatePristine(undefined, 'translation')).toBe(true);
  });

  it('treats a freshly created state as pristine', () => {
    for (const type of [
      'translation',
      'document',
      'data-analysis',
      'map',
    ] as const) {
      expect(
        isWorkflowStatePristine(createInitialWorkflowState(type), type),
      ).toBe(true);
    }
  });

  it('ignores updatedAt drift', () => {
    // createInitialWorkflowState stamps the current time, so a plain JSON
    // compare against a fresh state would never match.
    const state = {
      ...createInitialWorkflowState('translation'),
      updatedAt: '2020-01-01T00:00:00.000Z',
    } as TranslationWorkflowState;
    expect(isWorkflowStatePristine(state, 'translation')).toBe(true);
  });

  it('ignores key order', () => {
    const initial = createInitialWorkflowState('translation');
    const reordered = Object.fromEntries(
      Object.entries(initial).reverse(),
    ) as unknown as TranslationWorkflowState;
    expect(isWorkflowStatePristine(reordered, 'translation')).toBe(true);
  });

  it('treats explicit undefined fields as absent', () => {
    const state = {
      ...createInitialWorkflowState('translation'),
      finalText: undefined,
    } as TranslationWorkflowState;
    expect(isWorkflowStatePristine(state, 'translation')).toBe(true);
  });

  it('detects typed source text', () => {
    const state = {
      ...createInitialWorkflowState('translation'),
      sourceText: 'bonjour',
    } as TranslationWorkflowState;
    expect(isWorkflowStatePristine(state, 'translation')).toBe(false);
  });

  it('detects a changed scalar setting', () => {
    const state = {
      ...createInitialWorkflowState('translation'),
      mode: 'quick',
    } as TranslationWorkflowState;
    expect(isWorkflowStatePristine(state, 'translation')).toBe(false);
  });

  it('detects nested content', () => {
    const state = createInitialWorkflowState('map');
    expect(
      isWorkflowStatePristine(
        {
          ...state,
          sources: [
            { id: 's1', name: 'report.pdf', addedAt: '', featureCount: 2 },
          ],
        } as typeof state,
        'map',
      ),
    ).toBe(false);
  });

  it('treats a kind mismatch as dirty rather than silently discardable', () => {
    expect(
      isWorkflowStatePristine(createInitialWorkflowState('map'), 'translation'),
    ).toBe(false);
  });
});
