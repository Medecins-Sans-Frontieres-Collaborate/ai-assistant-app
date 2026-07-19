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

    // Unconditional, unlike the other bypasses. A selection revise returns
    // only the revised excerpt, so there is no document to diff — turning
    // this off could only produce nonsense suggestions.
    expect(
      planRevision({
        ...base,
        scoped: true,
        exceptions: { largeRewrites: false, structuralReorders: false },
      }),
    ).toEqual({ kind: 'direct', reason: 'selection' });
  });

  it('suggests even a sentence-for-sentence total rewrite', () => {
    // Every sentence replaced, but one-for-one — so it splits into four
    // reviewable changes rather than one blob. This is the case the old
    // total-change rule bypassed, which made "suggest changes" look broken.
    const rewrite = {
      ...base,
      newMarkdown:
        'Entirely new prose. Nothing here resembles the original text. Every sentence has been replaced. The subject matter differs.',
    };
    const plan = planRevision(rewrite);
    expect(plan.kind).toBe('suggest');
    if (plan.kind === 'suggest') {
      expect(plan.changes.length).toBeGreaterThan(1);
    }

    const diff = computeRevisionEdits(rewrite.oldMarkdown, rewrite.newMarkdown);
    expect(diff.changeRatio).toBeGreaterThan(0.9); // almost all of it moved…
    expect(diff.largestChangeRatio).toBeLessThan(0.5); // …but in small pieces
  });

  it('applies directly when the threshold is lowered under the largest change', () => {
    const rewrite = {
      ...base,
      newMarkdown:
        'Entirely new prose. Nothing here resembles the original text. Every sentence has been replaced. The subject matter differs.',
    };
    const { largestChangeRatio } = computeRevisionEdits(
      rewrite.oldMarkdown,
      rewrite.newMarkdown,
    );
    expect(
      planRevision({
        ...rewrite,
        largeRewriteRatio: largestChangeRatio * 0.9,
      }),
    ).toEqual({ kind: 'direct', reason: 'largeRewrite' });
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

describe('turndown vs model formatting (regression)', () => {
  // The editor's HTML goes through turndown, which escapes markdown
  // metacharacters and pads list markers. The model returns plain markdown.
  // Comparing raw, nothing matched, every revision measured as a full rewrite
  // and silently bypassed suggestions.
  const fromEditor = `# Field Report 2024

Costs rose 30% in Q1 (see annex\\_2). Staffing reached twelve by June.

-   Gloves
-   Masks

Supplies arrived late in the quarter.`;

  const fromModel = `# Field Report 2024

Costs rose 30% in Q1 (see annex_2). Staffing reached fifteen by June.

- Gloves
- Masks

Supplies arrived late in the quarter.`;

  it('suggests the real change rather than reporting a full rewrite', () => {
    const diff = computeRevisionEdits(fromEditor, fromModel);

    expect(diff.fullyAnchored).toBe(true);
    // Only the sentence that actually changed — escaping and list padding are
    // not user-visible changes and must not become suggestions.
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].before).toContain('twelve');
    expect(diff.changes[0].after).toContain('fifteen');
    expect(diff.changeRatio).toBeLessThan(0.5);
  });

  it('plans to suggest it', () => {
    expect(
      planRevision({
        enabled: true,
        mode: 'revise',
        scoped: false,
        oldMarkdown: fromEditor,
        newMarkdown: fromModel,
        exceptions: {
          largeRewrites: true,
          structuralReorders: true,
        },
        largeRewriteRatio: 0.5,
      }).kind,
    ).toBe('suggest');
  });

  it('anchors against the ORIGINAL escaped text, so applyEdit can find it', () => {
    const diff = computeRevisionEdits(fromEditor, fromModel);
    for (const change of diff.changes) {
      expect(fromEditor).toContain(change.before);
    }
  });

  it('does not suggest anything when only formatting differs', () => {
    const reformatted = fromEditor
      .replace(/annex\\_2/, 'annex_2')
      .replace(/- {3}/g, '- ');
    const diff = computeRevisionEdits(fromEditor, reformatted);
    expect(diff.changes).toHaveLength(0);
  });
});

describe('granularity, not volume (regression)', () => {
  // The complaint: requested revisions were "always made without confirmation".
  // The old rule bypassed whenever TOTAL change crossed the threshold, so a
  // thorough revision — exactly the kind worth reviewing — was the one case
  // that never got reviewed.
  const original = `The clinic opened in March. Staffing reached twelve by June. Supplies arrived late in the quarter. The cold chain held throughout. Reporting used the agreed template. Travel was arranged regionally.`;

  // "Make this more formal" — nearly every sentence rewritten, but each one
  // separately reviewable.
  const thorough = `The facility commenced operations in March. Staffing levels attained twelve personnel by June. Supply deliveries were received late within the quarter. The cold chain was maintained throughout. Reporting adhered to the agreed template. Travel arrangements were coordinated regionally.`;

  const base = {
    enabled: true,
    mode: 'revise' as const,
    scoped: false,
    exceptions: { largeRewrites: true, structuralReorders: false },
    largeRewriteRatio: 0.5,
  };

  it('suggests a thorough rewrite instead of applying it', () => {
    const diff = computeRevisionEdits(original, thorough);
    // Most of the document changed...
    expect(diff.changeRatio).toBeGreaterThan(0.5);
    // ...but no single change dominates it, so it reviews fine.
    expect(diff.largestChangeRatio).toBeLessThan(0.5);
    expect(diff.changes.length).toBeGreaterThan(1);

    expect(
      planRevision({ ...base, oldMarkdown: original, newMarkdown: thorough })
        .kind,
    ).toBe('suggest');
  });

  it('still bypasses when the result is one indivisible block', () => {
    // Nothing in common: the diff collapses to a single change spanning the
    // whole document, and "accept" would mean accepting everything blind.
    const unrelated =
      'Completely different subject matter with no shared phrasing whatsoever throughout.';
    const diff = computeRevisionEdits(original, unrelated);
    expect(diff.largestChangeRatio).toBeGreaterThanOrEqual(0.5);

    expect(
      planRevision({ ...base, oldMarkdown: original, newMarkdown: unrelated }),
    ).toEqual({ kind: 'direct', reason: 'largeRewrite' });
  });

  it('normalizes ordered-list markers, which turndown pads', () => {
    const fromEditor =
      '# Plan\n\n1.  First step\n2.  Second step\n3.  Third step';
    const fromModel = '# Plan\n\n1. First step\n2. Revised step\n3. Third step';
    const diff = computeRevisionEdits(fromEditor, fromModel);

    expect(diff.fullyAnchored).toBe(true);
    // Only the genuinely changed item — `1.  ` versus `1. ` is not a change.
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].after).toContain('Revised step');
  });
});
