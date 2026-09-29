import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';

import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import { groundVersion } from '@/lib/utils/shared/drafter/core/grounding';
import {
  editSegmentText,
  emptyVersion,
} from '@/lib/utils/shared/drafter/core/versions';
import { CheckFinding } from '@/lib/utils/shared/review/deterministicChecks';

import {
  Brief,
  BriefItem,
  CitationMark,
  Segment,
  Version,
  VersionSpec,
} from '@/types/drafter';

import {
  VersionColumn,
  VersionColumnProps,
} from '@/components/Workflows/Shared/Drafter/VersionColumn';
import { SpecAdapterUi } from '@/components/Workflows/Shared/Drafter/adapterUi';
import { KEY_MESSAGE_REF } from '@/components/Workflows/Shared/Drafter/itemRefs';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

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

const SPEC: VersionSpec = {
  id: 'linkedin',
  kind: 'channel',
  name: 'LinkedIn',
  guidance: '',
  maxSegments: 1,
};

/** A kind adapter that fits everything and never folds. */
const UI: SpecAdapterUi = {
  namespace: 'workflows.channelDrafter',
  segmentMeta: (_spec, segments, index) => ({
    count: segments[index].text.length,
    limit: 3000,
    over: 0,
    overflowAt: null,
  }),
  firstSegmentSlot: () => null,
  copyPlan: (_spec, version) =>
    version.segments.map((segment) => ({
      segmentId: segment.id,
      text: segment.text,
    })),
};

function versionOf(text: string, patch: Partial<Version> = {}): Version {
  const segment: Segment = { id: 's1', text, usedItemIds: [] };
  return { ...emptyVersion(SPEC.id), segments: [segment], ...patch };
}

/**
 * What the cite step would say about the fixture sentences, so the column
 * can be rendered without a model. Anything else is 'pending'.
 */
const VERDICTS: Record<string, Pick<CitationMark, 'verdict' | 'itemIds'>> = {
  'Cholera cases doubled since January.': {
    verdict: 'supported',
    itemIds: ['f3'],
  },
  'The clinic treated 1,200 patients in March.': {
    verdict: 'supported',
    itemIds: ['f2'],
  },
  'Cholera cases halved since January.': { verdict: 'partly', itemIds: ['f3'] },
  'This is heartbreaking and we are proud of our teams.': {
    verdict: 'unsupported',
    itemIds: [],
  },
  'Our teams are heartbroken and proud.': {
    verdict: 'unsupported',
    itemIds: [],
  },
  'Clean water must reach every camp now.': {
    verdict: 'supported',
    itemIds: [KEY_MESSAGE_REF],
  },
  'Thank you all.': { verdict: 'unclear', itemIds: [] },
};

/** Cuts a segment into sentences and cites each from the table above. */
function citationsFor(version: Version): CitationMark[] {
  const marks: CitationMark[] = [];
  for (const segment of version.segments) {
    const pattern = /[^.\n]+[.]?/gu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment.text)) !== null) {
      const raw = match[0];
      const lead = raw.length - raw.trimStart().length;
      const sentence = raw.trim();
      if (!sentence) continue;
      const start = match.index + lead;
      const known = VERDICTS[sentence];
      marks.push({
        segmentId: segment.id,
        start,
        end: start + sentence.length,
        key: sentence.toLowerCase(),
        itemIds: known?.itemIds ?? [],
        verdict: known?.verdict ?? 'pending',
      });
    }
  }
  return marks;
}

const noop = () => undefined;

function propsFor(
  version: Version,
  partial: Partial<VersionColumnProps> = {},
): VersionColumnProps {
  return {
    spec: SPEC,
    version,
    ui: UI,
    layout: 'column',
    statuses: ['ready'],
    findings: [],
    marks: groundVersion(version.segments, BRIEF),
    citations: citationsFor(version),
    brief: BRIEF,
    sources: [],
    writing: false,
    pinned: false,
    canMoveEarlier: false,
    canMoveLater: false,
    tracedItemId: null,
    onTrace: vi.fn(),
    onEdit: vi.fn(),
    onSplit: vi.fn(),
    onMerge: vi.fn(),
    onFit: noop,
    onDropHashtags: noop,
    onTighten: noop,
    tighteningId: null,
    onApprove: noop,
    onCopied: noop,
    onUseProposed: noop,
    onKeepMine: noop,
    onRestore: noop,
    voices: [],
    onVoice: noop,
    onTeach: noop,
    previewing: false,
    onPreviewChange: noop,
    onAcceptEdit: noop,
    onRejectEdit: noop,
    onAcceptAllEdits: noop,
    onRevise: noop,
    onHide: noop,
    onTogglePin: noop,
    onMove: noop,
    onFocusMode: noop,
    onRetry: noop,
    onVerify: vi.fn(),
    verifyingId: null,
    ...partial,
  };
}

// The jsdom i18n mock has no workflows namespace: labels render as raw keys.
function renderColumn(text: string, partial: Partial<VersionColumnProps> = {}) {
  const props = propsFor(versionOf(text), partial);
  const view = render(<VersionColumn {...props} />);
  return { props, ...view };
}

/** Turns evidence mode on through the header toggle. */
function showEvidence() {
  fireEvent.click(screen.getByRole('button', { name: 'showProof' }));
}

/** The post's text container (the div holding the runs and chips). */
const textBox = (): HTMLElement =>
  document.querySelector('section div[dir="auto"].cursor-text') as HTMLElement;

/** The sentence chips: the only buttons inside the post's text. */
const chips = () =>
  within(textBox()).queryAllByRole('button', { name: /^citeChip/u });

/* ------------------------------------------------------------------ */
/* Rendering marks                                                     */
/* ------------------------------------------------------------------ */

describe('VersionColumn marks [ui]', () => {
  it('renders the text as plain runs with one chip per sentence', () => {
    const { container } = renderColumn(
      'The clinic treated 1,200 patients in March. Cholera cases doubled since January.',
    );
    // Evidence off: no chips, no buttons in the text, the number dotted.
    expect(chips()).toHaveLength(0);
    expect(textBox().querySelectorAll('button')).toHaveLength(0);
    const number = screen.getByText('1,200');
    expect(number.tagName).toBe('SPAN');
    expect(number.className).toContain('decoration-dotted');
    expect(container.querySelectorAll('sup')).toHaveLength(0);

    showEvidence();
    expect(chips()).toHaveLength(2);
    expect(chips().map((chip) => chip.textContent)).toEqual(['2', '3']);
    expect(chips()[0]).toHaveAttribute('aria-label', 'citeChip');
    // Nothing interactive is nested: the chip is the tab stop, the text is not.
    expect(textBox().querySelectorAll('button button')).toHaveLength(0);
    expect(textBox()).not.toHaveAttribute('role');
    expect(textBox()).not.toHaveAttribute('tabindex');
    const sentence = within(textBox()).getByText(
      'Cholera cases doubled since January.',
    );
    expect(sentence.tagName).toBe('SPAN');
    expect(sentence.className).toContain('decoration-solid');
    // The chip sits outside the underlined span.
    expect(sentence.querySelector('button')).toBeNull();
  });

  it('always shows an unsupported sentence wavy and amber, never red', () => {
    renderColumn('This is heartbreaking and we are proud of our teams.');
    const before = screen.getByText(
      'This is heartbreaking and we are proud of our teams.',
    );
    expect(before.className).toContain('decoration-wavy');
    expect(before.className).toContain('bg-amber-50');
    expect(before.className).not.toContain('red');
    // Evidence off: the state is still announced once, without a control.
    expect(chips()).toHaveLength(0);
    expect(textBox().querySelector('.sr-only')?.textContent).toBe(
      ', markUnsupported',
    );
    showEvidence();
    expect(chips()).toHaveLength(1);
    expect(chips()[0].textContent).toBe('?');
    expect(textBox().querySelector('.sr-only')).toBeNull();
  });

  it('underlines partly dashed, unclear dotted, and marks a pending sentence with a dot', () => {
    renderColumn(
      'Cholera cases halved since January. Thank you all. Something new.',
    );
    showEvidence();
    const box = within(textBox());
    expect(
      box.getByText('Cholera cases halved since January.').className,
    ).toContain('decoration-dashed');
    expect(box.getByText('Thank you all.').className).toContain(
      'decoration-dotted',
    );
    expect(box.getByText('Something new.').className).toContain(
      'decoration-dotted',
    );
    const [, unclear, pending] = chips();
    expect(unclear.textContent).toBe('?');
    expect(pending.textContent).toBe('');
    expect(pending.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('opens the editor at the pressed word when the text is clicked', () => {
    const text =
      'The clinic treated 1,200 patients in March. Cholera cases doubled since January.';
    renderColumn(text);
    showEvidence();
    // A press on the second sentence's run, not on its chip.
    fireEvent.click(
      within(textBox()).getByText('Cholera cases doubled since January.'),
    );
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe(text);
    expect(textarea.selectionStart).toBe(
      text.indexOf('Cholera cases doubled since January.'),
    );
  });

  it('opens the editor from the number inside a sentence too', () => {
    renderColumn('The clinic treated 1,200 patients in March.');
    fireEvent.click(screen.getByText('1,200'));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.selectionStart).toBe(
      'The clinic treated 1,200 patients in March.'.indexOf('1,200'),
    );
  });

  it('keeps a keyboard way into the editor as a real button', () => {
    renderColumn('Cholera cases doubled since January.');
    const edit = screen.getByRole('button', { name: 'editPost' });
    expect(edit.tagName).toBe('BUTTON');
    expect(edit.className).toContain('sr-only');
    fireEvent.click(edit);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('traces from the chip at once, and from the sentence after a pause', () => {
    vi.useFakeTimers();
    const { props } = renderColumn('Cholera cases doubled since January.');
    showEvidence();
    const sentence = within(textBox()).getByText(
      'Cholera cases doubled since January.',
    );
    fireEvent.mouseEnter(sentence);
    // Sweeping across a post must not flicker: nothing until the mouse rests.
    expect(props.onTrace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(props.onTrace).toHaveBeenCalledWith('f3');
    fireEvent.mouseLeave(sentence);
    expect(props.onTrace).toHaveBeenLastCalledWith(null);
    vi.useRealTimers();
    fireEvent.mouseEnter(chips()[0]);
    expect(props.onTrace).toHaveBeenCalledWith('f3');
    fireEvent.mouseLeave(chips()[0]);
    expect(props.onTrace).toHaveBeenLastCalledWith(null);
    fireEvent.focus(chips()[0]);
    expect(props.onTrace).toHaveBeenLastCalledWith('f3');
  });

  it('lights a fact-backed sentence when its item is traced, even with evidence off', () => {
    const { container } = renderColumn('Cholera cases doubled since January.', {
      tracedItemId: 'f3',
    });
    expect(chips()).toHaveLength(0);
    const lit = container.querySelector('.bg-blue-100');
    expect(lit).not.toBeNull();
    expect(lit?.textContent).toBe('Cholera cases doubled since January.');
  });

  it('sums up the citation step under the post, whatever the toggle says', () => {
    renderColumn('Cholera cases doubled since January.');
    const summary = screen.getByRole('button', { name: /citeSummary/u });
    expect(summary).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(summary);
    expect(chips().length).toBeGreaterThan(0);
  });

  it('opens a popover on the chip with the sentence, a card per item, the verdict and Check with AI', () => {
    const { props } = renderColumn('Cholera cases halved since January.');
    showEvidence();
    const chip = chips()[0];
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog');
    // Anchored to the chip: a sibling inside the chip's wrapper, not after the media block.
    expect(chip.parentElement).toBe(dialog.parentElement?.parentElement);
    expect(
      within(dialog).getByText('Cholera cases halved since January.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('citePartly')).toBeInTheDocument();
    // One ProofCard for f3 (no source: its verification line shows).
    expect(within(dialog).getByText('foundInSource')).toBeInTheDocument();
    expect(within(dialog).getByText(/citeExplainer/u)).toBeInTheDocument();
    const check = within(dialog).getByRole('button', { name: 'checkWithAi' });
    fireEvent.click(check);
    expect(props.onVerify).toHaveBeenCalledWith('s1', [
      { segmentId: 's1', text: 'Cholera cases halved since January.' },
    ]);
    // A press inside the popover is not a press on the post.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the key message as the referent of a sentence resting on it', () => {
    renderColumn('Clean water must reach every camp now.');
    showEvidence();
    expect(chips()[0].textContent).toBe('refKeyMessage');
    fireEvent.click(chips()[0]);
    expect(
      within(screen.getByRole('dialog')).getByText('fromKeyMessage'),
    ).toBeInTheDocument();
  });

  it('explains a shortened quotation and greys the words left out', () => {
    const text = 'She said: “We had no clean water … eleven days” and more.';
    renderColumn(text, {
      citations: [
        {
          segmentId: 's1',
          start: 0,
          end: text.length,
          key: 'k',
          itemIds: ['q1'],
          verdict: 'supported',
        },
      ],
    });
    const quote = screen.getByText('We had no clean water');
    expect(quote.tagName).toBe('SPAN');
    expect(quote).toHaveAttribute(
      'title',
      'quoteFull: We had no clean water for eleven days',
    );
    // The … is the writer's, not the speaker's.
    expect(screen.getByText('…').className).toContain('text-gray-700');
    showEvidence();
    fireEvent.click(chips()[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('quoteAbbreviated')).toBeInTheDocument();
    const greyed = [...dialog.querySelectorAll('span.text-gray-500')].map(
      (node) => node.textContent,
    );
    expect(greyed).toEqual([' for ']);
  });

  it('marks an ungrounded number amber and says so in the chip and the popover', () => {
    const text = 'The clinic treated 12,000 patients in March.';
    renderColumn(text, {
      citations: [
        {
          segmentId: 's1',
          start: 0,
          end: text.length,
          key: 'k',
          itemIds: [],
          verdict: 'unsupported',
          note: 'ungrounded-inside',
        },
      ],
    });
    const number = screen.getByText('12,000');
    expect(number.className).toContain('bg-amber-100');
    expect(number).toHaveAttribute('title', 'numberNotInBrief');
    showEvidence();
    fireEvent.click(chips()[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('numberNotInBrief')).toBeInTheDocument();
    // Code decided this one; the model is not asked.
    expect(
      within(dialog).queryByRole('button', { name: 'checkWithAi' }),
    ).not.toBeInTheDocument();
  });

  it('lists only the findings not already marked in the text', () => {
    // Quote and number findings are marked inline and listed in the
    // evidence; the findings list carries everything else.
    const findings: CheckFinding[] = [
      {
        checkId: 'quote-verbatim',
        severity: 'block',
        messageKey: 'quoteNotInBrief',
        targetId: 's1',
      },
      {
        checkId: 'number-grounded',
        severity: 'block',
        messageKey: 'numberNotInBrief',
        targetId: 's1',
      },
      { checkId: 'alt-missing', severity: 'block', messageKey: 'altMissing' },
    ];
    renderColumn('This is heartbreaking and we are proud of our teams.', {
      findings,
    });
    expect(
      screen.queryByText('checks.quoteNotInBrief'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('checks.numberNotInBrief'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('checks.altMissing')).toBeInTheDocument();
  });

  it('names the toggle Evidence with its hint as the tooltip', () => {
    renderColumn('Cholera cases doubled since January.');
    expect(screen.getByRole('button', { name: 'showProof' })).toHaveAttribute(
      'title',
      'showProofHint',
    );
  });

  it('keeps the Evidence toggle in Focus, on by default, with the details foldable', () => {
    renderColumn('Cholera cases doubled since January.', { layout: 'focus' });
    const toggle = screen.getByRole('button', { name: 'showProof' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(chips()).toHaveLength(1);
    // The evidence list is reachable below the text on a narrow screen.
    const fold = screen.getByRole('button', { name: 'checksAndProof' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(chips()).toHaveLength(0);
  });

  it('shows the check error beside the evidence list, not only in a popover', () => {
    renderColumn('This is heartbreaking and we are proud of our teams.', {
      verifyError: 'VERIFY_FAILED',
    });
    showEvidence();
    expect(screen.getByText('verifyFailed')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* Edit flow                                                           */
/* ------------------------------------------------------------------ */

/** Holds the version like the workspace does, so edits land in the text. */
function Harness({
  initial,
  partial = {},
  onVersion,
}: {
  initial: Version;
  partial?: Partial<VersionColumnProps>;
  onVersion?: (set: (version: Version) => void) => void;
}) {
  const [version, setVersion] = useState(initial);
  onVersion?.(setVersion);
  const props = propsFor(version, {
    onEdit: (segmentId, text) =>
      setVersion((current) => editSegmentText(current, segmentId, text)),
    ...partial,
  });
  return <VersionColumn {...props} />;
}

function editTo(text: string) {
  fireEvent.click(screen.getByRole('button', { name: 'editPost' }));
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: text } });
  return textarea;
}

describe('VersionColumn edit flow [ui]', () => {
  it('reports an unsupported edit after the editor closes, with Check with AI and Dismiss', () => {
    render(
      <Harness initial={versionOf('Cholera cases doubled since January.')} />,
    );
    const textarea = editTo(
      'Cholera cases doubled since January. Our teams are heartbroken and proud.',
    );
    // Never while the editor is open.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.blur(textarea);
    const strip = screen.getByRole('status');
    expect(strip).toHaveTextContent('editUnsupported');
    expect(
      screen.getByRole('button', { name: 'checkWithAi' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('reports a change the model traced as in the brief, and one still being checked', () => {
    render(
      <Harness initial={versionOf('Cholera cases doubled since January.')} />,
    );
    fireEvent.blur(
      editTo(
        'Cholera cases doubled since January. The clinic treated 1,200 patients in March.',
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent('editSupported');
    // The changed sentence is highlighted as fresh until dismissed.
    expect(
      screen.getByText('The clinic treated', { exact: false }).className,
    ).toContain('bg-blue-50');
    fireEvent.blur(
      editTo(
        'Cholera cases doubled since January. The clinic treated 1,200 patients in March. Something new.',
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent('editChecking');
  });

  it('puts a hard finding in the changed text before any verdict', () => {
    render(
      <Harness initial={versionOf('Cholera cases doubled since January.')} />,
    );
    fireEvent.blur(
      editTo(
        'Cholera cases doubled since January. The clinic treated 12,000 patients in March.',
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent('editHardProblem');
  });

  it('drops the strip once the text changes again, or another editor opens', () => {
    let set: ((version: Version) => void) | undefined;
    render(
      <Harness
        initial={versionOf('Cholera cases doubled since January.')}
        onVersion={(setter) => {
          set = setter;
        }}
      />,
    );
    fireEvent.blur(
      editTo(
        'Cholera cases doubled since January. Our teams are heartbroken and proud.',
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent('editUnsupported');
    // Reopening the editor hides it; closing unchanged brings it back, as
    // the edit it reports still stands.
    fireEvent.click(screen.getByRole('button', { name: 'editPost' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.blur(screen.getByRole('textbox'));
    expect(screen.getByRole('status')).toHaveTextContent('editUnsupported');
    // A new edit gets a new strip; a change from elsewhere drops it.
    fireEvent.blur(
      editTo(
        'Cholera cases doubled since January. Our teams are heartbroken and very proud.',
      ),
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => set?.(versionOf('Cholera cases doubled since January.')));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows no strip when the edit touches no sentence and no mark', () => {
    render(
      <Harness
        initial={versionOf('Cholera cases doubled since January.')}
        partial={{ citations: [] }}
      />,
    );
    fireEvent.blur(
      editTo('Cholera cases doubled since January. Thank you all.'),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('sends exactly the touched sentences to the model', () => {
    const onVerify = vi.fn();
    render(
      <Harness
        initial={versionOf(
          'Cholera cases doubled since January. Thank you all very much.',
        )}
        partial={{ onVerify }}
      />,
    );
    fireEvent.blur(
      editTo(
        'Cholera cases doubled since January. Thank you all very much. Our teams are heartbroken and proud.',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'checkWithAi' }));
    expect(onVerify).toHaveBeenCalledWith('s1', [
      { segmentId: 's1', text: 'Our teams are heartbroken and proud.' },
    ]);
  });

  it('shows the check running for this segment', () => {
    render(
      <Harness
        initial={versionOf('Cholera cases doubled since January.')}
        partial={{ verifyingId: 's1' }}
      />,
    );
    fireEvent.blur(
      editTo(
        'Cholera cases doubled since January. Our teams are heartbroken and proud.',
      ),
    );
    const busy = screen.getByRole('button', { name: 'checkingWithAi' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toBeDisabled();
  });

  it('shows the model’s reason for a sentence in the popover and the evidence list', () => {
    const sentence = 'The clinic treated 1,200 patients in March.';
    const version = versionOf(sentence);
    render(
      <VersionColumn
        {...propsFor(version, {
          citations: [
            {
              segmentId: 's1',
              start: 0,
              end: sentence.length,
              key: 'k',
              itemIds: ['f2'],
              verdict: 'partly',
              reason: 'The brief says March, not April.',
            },
          ],
        })}
      />,
    );
    showEvidence();
    fireEvent.click(chips()[0]);
    // Rendered in the popover and, with evidence on, in the evidence list.
    expect(screen.getAllByText('citePartly').length).toBe(2);
    expect(screen.getAllByText('aiSays').length).toBe(2);
  });
});
