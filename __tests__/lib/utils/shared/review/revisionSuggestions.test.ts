import { applyEditsInOrder } from '@/lib/utils/shared/review/editApplication';
import {
  computeRevisionEdits,
  planRevision,
} from '@/lib/utils/shared/review/revisionSuggestions';

import { describe, expect, it } from 'vitest';

/** Applies every produced change the way the review queue would. */
function applyAll(
  original: string,
  changes: { before: string; after: string }[],
) {
  return applyEditsInOrder(
    original,
    changes.map((c, index) => ({ id: String(index), ...c })),
  );
}

describe('computeRevisionEdits', () => {
  it('returns nothing for an unchanged document', () => {
    const text = 'One sentence. Two sentences.';
    const result = computeRevisionEdits(text, text);
    expect(result.changes).toEqual([]);
    expect(result.changeRatio).toBe(0);
    expect(result.fullyAnchored).toBe(true);
  });

  it('produces before strings that are verbatim, locatable substrings', () => {
    const before = 'The cat sat. The dog barked. The bird flew.';
    const after = 'The cat sat. The dog howled. The bird flew.';
    const result = computeRevisionEdits(before, after);

    expect(result.fullyAnchored).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);
    for (const change of result.changes) {
      // The contract applyEdit depends on: exact substring, found by indexOf.
      expect(before).toContain(change.before);
    }
  });

  it('round-trips: accepting every change reproduces the rewrite', () => {
    const before =
      'Intro paragraph here. The budget was 100 dollars. We shipped in May. Final note.';
    const after =
      'Intro paragraph here. The budget was 250 dollars. We shipped in June. Final note.';
    const result = computeRevisionEdits(before, after);

    expect(result.fullyAnchored).toBe(true);
    const applied = applyAll(before, result.changes);
    expect(applied.failedIds).toEqual([]);
    expect(applied.text).toBe(after);
  });

  it('anchors a pure insertion, which has no text of its own to match', () => {
    const before = 'First point. Third point.';
    const after = 'First point. Second point. Third point.';
    const result = computeRevisionEdits(before, after);

    expect(result.fullyAnchored).toBe(true);
    // An empty `before` is rejected outright by applyEdit, so the change must
    // have borrowed a neighbouring sentence as its anchor.
    for (const change of result.changes) {
      expect(change.before).not.toBe('');
      expect(before).toContain(change.before);
    }
    expect(applyAll(before, result.changes).text).toBe(after);
  });

  it('anchors a pure deletion', () => {
    const before = 'Keep this. Delete this. Keep that.';
    const after = 'Keep this. Keep that.';
    const result = computeRevisionEdits(before, after);

    expect(result.fullyAnchored).toBe(true);
    expect(applyAll(before, result.changes).text).toBe(after);
  });

  it('widens a repeated sentence with context until it is unique', () => {
    // "See above." appears three times — matching the first would rewrite a
    // passage the user never reviewed.
    const before =
      'Alpha section. See above. Beta section. See above. Gamma section. See above.';
    const after =
      'Alpha section. See above. Beta section. See the table. Gamma section. See above.';
    const result = computeRevisionEdits(before, after);

    expect(result.fullyAnchored).toBe(true);
    for (const change of result.changes) {
      expect(before.indexOf(change.before)).toBe(
        before.lastIndexOf(change.before),
      );
    }
    expect(applyAll(before, result.changes).text).toBe(after);
  });

  it('reports a low change ratio for a touch-up and a high one for a rewrite', () => {
    const original =
      'The quarterly report covers three regions. Revenue grew steadily. The team expanded. We opened two offices.';

    const touched = computeRevisionEdits(
      original,
      original.replace('grew steadily', 'grew sharply'),
    );
    expect(touched.changeRatio).toBeLessThan(0.3);

    const rewritten = computeRevisionEdits(
      original,
      'Wholly different prose about unrelated matters. Nothing survives from the source. Every clause is new.',
    );
    expect(rewritten.changeRatio).toBeGreaterThan(0.7);
  });

  it('flags a moved block as a reorder rather than an edit', () => {
    const section =
      'The methodology section explains our sampling approach in considerable detail for reviewers.';
    const before = `Introduction here. ${section} Conclusion here.`;
    const after = `Introduction here. Conclusion here. ${section}`;

    expect(computeRevisionEdits(before, after).hasReorder).toBe(true);
  });

  it('does not flag ordinary edits as reorders', () => {
    const before =
      'The budget was approved in March by the steering committee after review.';
    const after =
      'The budget was approved in April by the steering committee after review.';
    expect(computeRevisionEdits(before, after).hasReorder).toBe(false);
  });

  it('refuses to anchor a document too large to diff', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `Sentence ${i}.`).join(
      ' ',
    );
    const result = computeRevisionEdits(huge, `${huge} One more.`);
    expect(result.fullyAnchored).toBe(false);
  });

  it('refuses when one side is empty', () => {
    expect(computeRevisionEdits('', 'New text.').fullyAnchored).toBe(false);
    expect(computeRevisionEdits('Old text.', '').fullyAnchored).toBe(false);
  });

  it('never emits overlapping spans, which would corrupt each other', () => {
    const before =
      'Repeated line. Repeated line. Repeated line. Repeated line. Tail.';
    const after =
      'Changed one. Repeated line. Changed two. Repeated line. Tail.';
    const result = computeRevisionEdits(before, after);

    const spans = result.changes.map((c) => {
      const at = before.indexOf(c.before);
      return [at, at + c.before.length] as const;
    });
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        const overlaps = spans[i][0] < spans[j][1] && spans[j][0] < spans[i][1];
        expect(overlaps).toBe(false);
      }
    }
    // Whatever survived must still apply cleanly.
    expect(applyAll(before, result.changes).failedIds).toEqual([]);
  });

  it('preserves markdown structure characters byte for byte', () => {
    const before = '# Title\n\n- First item\n- Second item\n\nClosing para.';
    const after = '# Title\n\n- First item\n- Revised item\n\nClosing para.';
    const result = computeRevisionEdits(before, after);

    expect(result.fullyAnchored).toBe(true);
    expect(applyAll(before, result.changes).text).toBe(after);
  });
});

describe('planRevision', () => {
  const base = {
    enabled: true,
    mode: 'revise' as const,
    scoped: false,
    oldMarkdown:
      'The project began in March. Funding came from three donors. The team had six members. Results were published in autumn.',
    newMarkdown:
      'The project began in March. Funding came from four donors. The team had six members. Results were published in autumn.',
    exceptions: {
      selectionScoped: true,
      largeRewrites: true,
      structuralReorders: true,
    },
    largeRewriteRatio: 0.5,
  };

  it('suggests an ordinary requested revision', () => {
    const plan = planRevision(base);
    expect(plan.kind).toBe('suggest');
    if (plan.kind === 'suggest') {
      expect(plan.changes.length).toBeGreaterThan(0);
    }
  });

  it('applies directly when the user unticked the checkbox', () => {
    const plan = planRevision({ ...base, enabled: false });
    expect(plan).toEqual({ kind: 'direct', reason: 'disabled' });
  });

  it('applies directly when writing from a blank document', () => {
    const plan = planRevision({
      ...base,
      mode: 'generate',
      oldMarkdown: '',
    });
    expect(plan).toEqual({ kind: 'direct', reason: 'generate' });
  });

  it('applies directly for a revision the user did not request', () => {
    const plan = planRevision({ ...base, automatic: true });
    expect(plan).toEqual({ kind: 'direct', reason: 'automatic' });
  });

  it('applies directly for a selection-scoped revision, unless turned off', () => {
    expect(planRevision({ ...base, scoped: true })).toEqual({
      kind: 'direct',
      reason: 'selection',
    });

    // The exception is configurable: off means selections get suggested too.
    const plan = planRevision({
      ...base,
      scoped: true,
      exceptions: { ...base.exceptions, selectionScoped: false },
    });
    expect(plan.kind).toBe('suggest');
  });

  it('applies directly for a wholesale rewrite, at the configured threshold', () => {
    const rewrite = {
      ...base,
      newMarkdown:
        'Entirely new prose. Nothing here resembles the original text. Every sentence has been replaced. The subject matter differs.',
    };
    expect(planRevision(rewrite)).toEqual({
      kind: 'direct',
      reason: 'largeRewrite',
    });

    // The threshold is the knob, so bracket the MEASURED ratio rather than
    // guessing a number — a total replacement measures exactly 1.0, which no
    // threshold below 1 can clear.
    const measured = computeRevisionEdits(
      rewrite.oldMarkdown,
      rewrite.newMarkdown,
    ).changeRatio;
    expect(
      planRevision({ ...rewrite, largeRewriteRatio: measured * 0.9 }).kind,
    ).toBe('direct');

    // Turning the exception off lets even a full rewrite through.
    expect(
      planRevision({
        ...rewrite,
        exceptions: { ...base.exceptions, largeRewrites: false },
      }).kind,
    ).toBe('suggest');
  });

  it('applies directly when sections were moved, unless turned off', () => {
    // Long enough that relocating one sentence stays well under the
    // large-rewrite threshold — otherwise that exception fires first and the
    // reorder rule is never reached.
    const filler =
      'The team met weekly to review progress against the plan. Each milestone was signed off by the steering group. Travel was arranged through the regional office. Procurement followed the standard framework. Reporting used the agreed template throughout.';
    const section =
      'Funding came from three donors who each committed to a multi-year grant.';
    const moved = {
      ...base,
      oldMarkdown: `The project began in March. ${section} ${filler} Results were published in autumn.`,
      newMarkdown: `The project began in March. ${filler} Results were published in autumn. ${section}`,
    };
    expect(planRevision(moved)).toEqual({ kind: 'direct', reason: 'reorder' });

    expect(
      planRevision({
        ...moved,
        exceptions: { ...base.exceptions, structuralReorders: false },
      }).kind,
    ).not.toBe('direct');
  });

  it('applies directly when the rewrite came back identical', () => {
    const plan = planRevision({ ...base, newMarkdown: base.oldMarkdown });
    expect(plan).toEqual({ kind: 'direct', reason: 'noChanges' });
  });

  it('applies directly when changes cannot be anchored', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `Sentence ${i}.`).join(
      ' ',
    );
    const plan = planRevision({
      ...base,
      oldMarkdown: huge,
      newMarkdown: `${huge} Extra.`,
    });
    expect(plan).toEqual({ kind: 'direct', reason: 'unanchorable' });
  });
});
