import {
  ANALYSIS_STRIP_HEIGHT,
  TRANSLATION_ACTIVITY,
  buildProgressSteps,
  clampAnalysisStripHeight,
  countAnalysisNotes,
  deriveRunStage,
  formatElapsed,
  hasPaperTrail,
  lastReviewVerdict,
  translationRunSteps,
} from '@/lib/utils/shared/translation/runProgress';

import { describe, expect, it } from 'vitest';

const statuses = (steps: { id: string; status: string }[]) =>
  steps.map((step) => `${step.id}:${step.status}`);

describe('deriveRunStage', () => {
  it('maps each reported activity to its step in a Reviewed run', () => {
    expect(deriveRunStage(TRANSLATION_ACTIVITY.analyzing, 'agentic')).toBe(
      'analyzing',
    );
    expect(deriveRunStage(TRANSLATION_ACTIVITY.translating, 'agentic')).toBe(
      'translating',
    );
    expect(deriveRunStage(TRANSLATION_ACTIVITY.reviewing, 'agentic')).toBe(
      'reviewing',
    );
  });

  it('starts on the first step of the mode before any activity arrives', () => {
    expect(deriveRunStage(undefined, 'agentic')).toBe('analyzing');
    expect(deriveRunStage(undefined, 'quick')).toBe('translating');
  });

  it('ignores activities the mode does not have, and unknown keys', () => {
    expect(deriveRunStage(TRANSLATION_ACTIVITY.reviewing, 'quick')).toBe(
      'translating',
    );
    expect(deriveRunStage('chat.activity.other', 'agentic')).toBe('analyzing');
  });
});

describe('buildProgressSteps', () => {
  const order = ['a', 'b', 'c'] as const;

  it('marks steps before the active one done and after it upcoming', () => {
    expect(statuses(buildProgressSteps(order, 'b'))).toEqual([
      'a:done',
      'b:active',
      'c:upcoming',
    ]);
  });

  it('handles the first and the last step being active', () => {
    expect(statuses(buildProgressSteps(order, 'a'))).toEqual([
      'a:active',
      'b:upcoming',
      'c:upcoming',
    ]);
    expect(statuses(buildProgressSteps(order, 'c'))).toEqual([
      'a:done',
      'b:done',
      'c:active',
    ]);
  });

  it('leaves every step upcoming for an id that is not a step', () => {
    expect(
      statuses(buildProgressSteps<string>(order, 'missing')).every((entry) =>
        entry.endsWith(':upcoming'),
      ),
    ).toBe(true);
  });
});

describe('translationRunSteps', () => {
  it('gives a Reviewed run four steps and never marks done as reached', () => {
    expect(statuses(translationRunSteps('agentic', 'reviewing'))).toEqual([
      'analyzing:done',
      'translating:done',
      'reviewing:active',
      'done:upcoming',
    ]);
  });

  it('gives a Quick run only the steps it has', () => {
    expect(statuses(translationRunSteps('quick', 'translating'))).toEqual([
      'translating:active',
      'done:upcoming',
    ]);
  });
});

describe('formatElapsed', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7.9)).toBe('0:07');
    expect(formatElapsed(59)).toBe('0:59');
    expect(formatElapsed(60)).toBe('1:00');
    expect(formatElapsed(760)).toBe('12:40');
  });

  it('floors a negative duration at zero', () => {
    expect(formatElapsed(-3)).toBe('0:00');
  });
});

describe('paper trail summaries', () => {
  const analysis = {
    register: 'clinical',
    trickyTerms: [{ term: 'PO', issue: 'abbreviation', suggestion: 'VO' }],
    ambiguities: [
      { text: 'early', readings: ['promptly', 'early in the course'] },
      { text: 'tab', readings: ['tablet', 'browser tab'] },
    ],
    notes: 'Keep dose formats.',
  };

  it('counts tricky terms and ambiguities as notes', () => {
    expect(countAnalysisNotes(analysis)).toBe(3);
    expect(countAnalysisNotes(undefined)).toBe(0);
  });

  it('reports the verdict of the last round only', () => {
    expect(lastReviewVerdict([])).toBeUndefined();
    expect(
      lastReviewVerdict([
        { round: 1, verdict: 'revise', issues: [] },
        { round: 2, verdict: 'approve', issues: [] },
      ]),
    ).toBe('approve');
  });

  it('has a paper trail only when something would be shown', () => {
    expect(hasPaperTrail({ rounds: [] })).toBe(false);
    expect(
      hasPaperTrail({
        rounds: [],
        glossaryCheck: { checkedTerms: 0, violations: [] },
      }),
    ).toBe(false);
    expect(
      hasPaperTrail({
        rounds: [],
        glossaryCheck: { checkedTerms: 1, violations: [] },
      }),
    ).toBe(true);
    expect(hasPaperTrail({ rounds: [], analysis })).toBe(true);
    expect(
      hasPaperTrail({
        rounds: [{ round: 1, verdict: 'approve', issues: [] }],
      }),
    ).toBe(true);
  });
});

describe('clampAnalysisStripHeight', () => {
  const { min, max } = ANALYSIS_STRIP_HEIGHT;

  it('keeps heights inside the range, including both bounds', () => {
    expect(clampAnalysisStripHeight(min)).toBe(min);
    expect(clampAnalysisStripHeight(max)).toBe(max);
    expect(clampAnalysisStripHeight(300.4)).toBe(300);
  });

  it('pulls heights just outside the range back to the bound', () => {
    expect(clampAnalysisStripHeight(min - 1)).toBe(min);
    expect(clampAnalysisStripHeight(max + 1)).toBe(max);
  });

  it('falls back to the default for a value that is not a number', () => {
    expect(clampAnalysisStripHeight(Number.NaN)).toBe(
      ANALYSIS_STRIP_HEIGHT.default,
    );
    expect(clampAnalysisStripHeight(Number.POSITIVE_INFINITY)).toBe(
      ANALYSIS_STRIP_HEIGHT.default,
    );
  });

  it('keeps the default itself inside the range', () => {
    expect(ANALYSIS_STRIP_HEIGHT.default).toBeGreaterThanOrEqual(min);
    expect(ANALYSIS_STRIP_HEIGHT.default).toBeLessThanOrEqual(max);
  });
});
