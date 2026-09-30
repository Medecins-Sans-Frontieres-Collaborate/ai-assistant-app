import { fireEvent, render, screen, within } from '@testing-library/react';

import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import { groundVersion } from '@/lib/utils/shared/drafter/core/grounding';

import {
  Brief,
  BriefItem,
  CitationMark,
  DRAFTER_LIMITS,
  Segment,
  Version,
} from '@/types/drafter';

import {
  ProofList,
  citationClass,
  staleReason,
} from '@/components/Workflows/Shared/Drafter/ProofList';
import {
  CALL_TO_ACTION_REF,
  KEY_MESSAGE_REF,
} from '@/components/Workflows/Shared/Drafter/itemRefs';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

function item(partial: Partial<BriefItem> & { id: string }): BriefItem {
  return {
    kind: 'fact',
    text: '',
    provenance: [],
    verified: 'verbatim',
    decision: 'included',
    ...partial,
  };
}

const BRIEF: Brief = {
  ...emptyBrief(),
  language: 'English',
  keyMessage: 'Clean water must reach every camp now',
  callToAction: 'Donate today to fund water trucks.',
  items: [
    item({
      id: 'q1',
      kind: 'quote',
      text: 'We had no clean water for eleven days',
      attribution: { name: 'Amina Yusuf', role: 'nurse' },
    }),
    item({
      id: 'f2',
      kind: 'figure',
      text: 'The clinic treated 1,200 patients in March',
    }),
    item({ id: 'f3', text: 'Cholera cases doubled since January' }),
  ],
};

const seg = (id: string, text: string): Segment => ({
  id,
  text,
  usedItemIds: [],
});

/** A citation mark for a sentence found in its segment. */
function cite(
  segment: Segment,
  sentence: string,
  verdict: CitationMark['verdict'],
  itemIds: string[] = [],
  extra: Partial<CitationMark> = {},
): CitationMark {
  const start = segment.text.indexOf(sentence);
  if (start < 0) throw new Error(`not in segment: ${sentence}`);
  return {
    segmentId: segment.id,
    start,
    end: start + sentence.length,
    key: sentence.toLowerCase(),
    itemIds,
    verdict,
    ...extra,
  };
}

// The jsdom i18n mock has no workflows namespace: labels render as raw keys.
function renderList(
  segments: Segment[],
  citations: CitationMark[],
  extra: {
    onVerify?: (claims: unknown) => void;
    verifyingId?: string | 'all' | null;
    error?: string;
    version?: Version;
  } = {},
) {
  return render(
    <ProofList
      marks={groundVersion(segments, BRIEF)}
      citations={citations}
      segments={segments}
      brief={BRIEF}
      sources={[]}
      {...extra}
    />,
  );
}

describe('ProofList [ui-proof]', () => {
  it('sums up the sentences by verdict and the hard checks on their own line', () => {
    const s1 = seg(
      's1',
      'The clinic treated 1,200 patients in March. This is heartbreaking and we are proud of our teams. Cholera cases doubled. Something else happened.',
    );
    renderList(
      [s1],
      [
        cite(s1, 'The clinic treated 1,200 patients in March.', 'supported', [
          'f2',
        ]),
        cite(
          s1,
          'This is heartbreaking and we are proud of our teams.',
          'unsupported',
        ),
        cite(s1, 'Cholera cases doubled.', 'partly', ['f3']),
        cite(s1, 'Something else happened.', 'pending'),
      ],
    );
    const summary = screen.getByText(/citeSummary/u);
    expect(summary).toHaveTextContent(
      'citeSummary · proofPartlyCount · proofUnsupportedCount · proofUncheckedCount',
    );
    expect(
      screen.getByText(/proofUnsupportedCount/u, { selector: 'span' })
        .className,
    ).toContain('text-amber-900');
    // The quotes and numbers: 1 of 1 traced.
    expect(screen.getByText(/proofSummary/u)).toBeInTheDocument();
    expect(screen.queryByText(/proofUngroundedCount/u)).not.toBeInTheDocument();
  });

  it('lists the sentences in order, each with its item tags and verdict', () => {
    const s1 = seg('s1', 'Cholera cases doubled since January. Thank you all.');
    const s2 = seg(
      's2',
      'This is heartbreaking and we are proud of our teams. Donate today to fund water trucks.',
    );
    renderList(
      [s1, s2],
      [
        cite(s2, 'Donate today to fund water trucks.', 'supported', [
          CALL_TO_ACTION_REF,
        ]),
        cite(
          s2,
          'This is heartbreaking and we are proud of our teams.',
          'unsupported',
        ),
        cite(s1, 'Cholera cases doubled since January.', 'supported', ['f3']),
        cite(s1, 'Thank you all.', 'unclear'),
      ],
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('p')?.textContent)).toEqual([
      '3Cholera cases doubled since January.',
      '?Thank you all.',
      '?This is heartbreaking and we are proud of our teams.',
      'refCallToActionDonate today to fund water trucks.',
    ]);
    expect(
      within(rows[0]).getByText('statementSupportedBy'),
    ).toBeInTheDocument();
    expect(within(rows[1]).getByText('citeUnclear')).toBeInTheDocument();
    expect(within(rows[2]).getByText('citeUnsupported')).toBeInTheDocument();
    expect(within(rows[3]).getByText('fromCallToAction')).toBeInTheDocument();
    // One tab stop per sentence at most: no button inside the sentence text.
    expect(rows[0].querySelectorAll('p button')).toHaveLength(0);
  });

  it('shows the cited item’s card and the model’s reason', () => {
    const s1 = seg('s1', 'Cholera cases doubled since January.');
    renderList(
      [s1],
      [
        cite(s1, 'Cholera cases doubled since January.', 'supported', ['f3'], {
          reason: 'Restates fact 3.',
          modelId: 'gpt-x',
        }),
      ],
    );
    expect(screen.getByText('foundInSource')).toBeInTheDocument();
    expect(screen.getByText('aiSays')).toBeInTheDocument();
    expect(screen.getByText('gpt-x')).toBeInTheDocument();
  });

  it('lists an ungrounded number inside a sentence as a hard finding, never overruled', () => {
    const s1 = seg('s1', 'The clinic treated 12,000 patients in March.');
    renderList(
      [s1],
      [
        cite(
          s1,
          'The clinic treated 12,000 patients in March.',
          'unsupported',
          [],
          { note: 'ungrounded-inside' },
        ),
      ],
      { onVerify: vi.fn() },
    );
    expect(screen.getByText(/proofUngroundedCount/u)).toBeInTheDocument();
    // In the sentence's panel, and as its own row (it blocks).
    expect(screen.getAllByText('numberNotInBrief').length).toBe(2);
    // Code decided this one: it is not sent to the model.
    expect(
      screen.queryByRole('button', { name: 'checkWithAi' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'checkAllWithAi' }),
    ).not.toBeInTheDocument();
  });

  it('lists a number no sentence carries after the sentences', () => {
    const s1 = seg(
      's1',
      'Cholera cases doubled since January.\n\n1 200 treated.',
    );
    renderList(
      [s1],
      [cite(s1, 'Cholera cases doubled since January.', 'supported', ['f3'])],
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The figure is f2's, so its row carries that ref and f2's card.
    expect(rows[1].querySelector('p')?.textContent).toBe('21 200');
    expect(rows[1]).toHaveTextContent('foundInSource');
  });

  it('says why a verdict lapsed: the brief changed, or an item left it', () => {
    const s1 = seg('s1', 'Cholera cases doubled since January.');
    const mark = cite(s1, 'Cholera cases doubled since January.', 'stale', [], {
      key: 'k1',
    });
    const version = (itemIds: string[]): Version => ({
      specId: 'x',
      segments: [s1],
      briefRev: 1,
      briefDigest: '',
      handEdited: false,
      history: [],
      verdicts: [
        {
          id: 'v1',
          segmentId: 's1',
          sentenceKey: 'k1',
          verdict: 'supported',
          itemIds,
          reason: '',
          at: '2026-09-23T00:00:00.000Z',
        },
      ],
    });
    const excluded: Brief = {
      ...BRIEF,
      items: BRIEF.items.map((entry) =>
        entry.id === 'f3' ? { ...entry, decision: 'excluded' } : entry,
      ),
    };
    expect(staleReason(version(['f3']), mark, excluded)).toBe('item-excluded');
    expect(staleReason(version(['f3']), mark, BRIEF)).toBe('brief-changed');
    expect(staleReason(version([KEY_MESSAGE_REF]), mark, excluded)).toBe(
      'brief-changed',
    );
    expect(staleReason(undefined, mark, excluded)).toBe('brief-changed');
    render(
      <ProofList
        marks={[]}
        citations={[mark]}
        segments={[s1]}
        brief={excluded}
        sources={[]}
        version={version(['f3'])}
      />,
    );
    expect(screen.getByText('citeStaleExcluded')).toBeInTheDocument();
    expect(screen.getByText(/proofStaleCount/u)).toBeInTheDocument();
  });

  it('sends at most twelve sentences to the model and says so', () => {
    const onVerify = vi.fn();
    const sentences = Array.from(
      { length: DRAFTER_LIMITS.MAX_VERIFY_CLAIMS + 2 },
      (_, index) =>
        `Our teams are heartbroken and proud of round ${index + 1}.`,
    );
    const s1 = seg('s1', sentences.join(' '));
    renderList(
      [s1],
      sentences.map((sentence) => cite(s1, sentence, 'pending')),
      { onVerify },
    );
    expect(screen.getByText(/verifyMore/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'checkAllWithAi' }));
    expect(onVerify).toHaveBeenCalledTimes(1);
    const claims = onVerify.mock.calls[0][0] as Array<{ text: string }>;
    expect(claims).toHaveLength(DRAFTER_LIMITS.MAX_VERIFY_CLAIMS);
    expect(claims[0]).toEqual({ segmentId: 's1', text: sentences[0] });
  });

  it('offers no column check without a handler or when every sentence is supported', () => {
    const s1 = seg('s1', 'Cholera cases doubled since January.');
    const marks = [
      cite(s1, 'Cholera cases doubled since January.', 'supported', ['f3']),
    ];
    renderList([s1], marks, { onVerify: vi.fn() });
    expect(
      screen.queryByRole('button', { name: 'checkAllWithAi' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/verifyMore/u)).not.toBeInTheDocument();
  });

  it('shows progress only for the sentences being checked, and the error by the button', () => {
    const s1 = seg(
      's1',
      'This is heartbreaking and we are proud of our teams.',
    );
    const s2 = seg('s2', 'Thank you all so very much.');
    const marks = [
      cite(
        s1,
        'This is heartbreaking and we are proud of our teams.',
        'unsupported',
      ),
      cite(s2, 'Thank you all so very much.', 'unclear'),
    ];
    const { rerender } = renderList([s1, s2], marks, {
      onVerify: vi.fn(),
      verifyingId: 's1',
    });
    // The s1 card is busy; the s2 card and the column button are only
    // disabled, and say why.
    const busy = screen.getAllByRole('button', { name: 'checkingWithAi' });
    expect(busy).toHaveLength(1);
    expect(busy[0]).toHaveAttribute('aria-busy', 'true');
    const waiting = screen.getByRole('button', { name: 'checkWithAi' });
    expect(waiting).toBeDisabled();
    expect(waiting).toHaveAttribute('title', 'checkRunning');
    const column = screen.getByRole('button', { name: 'checkAllWithAi' });
    expect(column).toBeDisabled();
    expect(column).toHaveAttribute('title', 'checkRunning');
    expect(column).not.toHaveAttribute('aria-busy');

    rerender(
      <ProofList
        marks={groundVersion([s1, s2], BRIEF)}
        citations={marks}
        segments={[s1, s2]}
        brief={BRIEF}
        sources={[]}
        onVerify={vi.fn()}
        verifyingId="all"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'checkingWithAi' }),
    ).toHaveAttribute('aria-busy', 'true');

    rerender(
      <ProofList
        marks={groundVersion([s1, s2], BRIEF)}
        citations={marks}
        segments={[s1, s2]}
        brief={BRIEF}
        sources={[]}
        onVerify={vi.fn()}
        verifyingId={null}
        error="verifyFailed"
      />,
    );
    expect(screen.getByText('verifyFailed')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'checkAllWithAi' }),
    ).toBeEnabled();
  });

  it('puts the explainer on the page once and points every check at it', () => {
    const s1 = seg(
      's1',
      'This is heartbreaking and we are proud of our teams.',
    );
    renderList(
      [s1],
      [
        cite(
          s1,
          'This is heartbreaking and we are proud of our teams.',
          'unsupported',
        ),
      ],
      { onVerify: vi.fn() },
    );
    expect(screen.getAllByText(/citeExplainer/u)).toHaveLength(1);
    const explainer = screen.getByText(/citeExplainer/u);
    for (const name of ['checkAllWithAi', 'checkWithAi']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute(
        'aria-describedby',
        explainer.id,
      );
    }
  });

  it('says there is nothing to trace only when there are no marks at all', () => {
    renderList([seg('s1', 'Thank you all.')], []);
    expect(screen.getByText('proofNothing')).toBeInTheDocument();
  });
});

describe('citationClass', () => {
  it('shows only an unsupported sentence outside evidence mode, never in red', () => {
    expect(citationClass('unsupported', false)).toContain('decoration-wavy');
    expect(citationClass('unsupported', false)).toContain('amber');
    for (const verdict of [
      'supported',
      'partly',
      'unclear',
      'pending',
      'stale',
    ] as const) {
      expect(citationClass(verdict, false)).toBe('');
      expect(citationClass(verdict, true)).not.toContain('red');
    }
    expect(citationClass('supported', true)).toContain('decoration-solid');
    expect(citationClass('partly', true)).toContain('decoration-dashed');
    expect(citationClass('unclear', true)).toContain('decoration-dotted');
    expect(citationClass('pending', true)).toContain('decoration-dotted');
    expect(citationClass('stale', true)).toContain('decoration-dotted');
  });
});
