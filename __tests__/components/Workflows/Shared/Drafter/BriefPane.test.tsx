import { fireEvent, render, screen } from '@testing-library/react';

import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';

import { Brief, BriefItem, DraftSource } from '@/types/drafter';

import {
  BriefPane,
  BriefPaneProps,
} from '@/components/Workflows/Shared/Drafter/BriefPane';
import { shortSpecName } from '@/components/Workflows/Shared/Drafter/specNames';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const source = (id: string, name: string): DraftSource => ({
  id,
  kind: 'url',
  name,
  url: `https://example.org/${id}`,
  chars: 100,
  addedAt: '2026-09-21T00:00:00.000Z',
});

const item = (
  id: string,
  text: string,
  partial: Partial<BriefItem> = {},
): BriefItem => ({
  id,
  kind: 'quote',
  text,
  provenance: [{ sourceId: 'a', excerpt: text }],
  verified: 'verbatim',
  decision: 'included',
  attribution: { name: 'Amina Yusuf', role: 'nurse' },
  ...partial,
});

const brief: Brief = {
  ...emptyBrief(),
  keyMessage: 'Water is life',
  items: [
    item('i1', 'We had no clean water for eleven days.'),
    item('i2', 'Nobody came.', { verified: 'unverified', decision: undefined }),
    item('i3', 'The clinic treated many people.', { kind: 'fact' }),
  ],
};

// The jsdom i18n mock has no workflows namespace: labels render as raw keys.
function renderPane(partial: Partial<BriefPaneProps> = {}) {
  const props: BriefPaneProps = {
    brief,
    sources: [source('a', 'DR Congo: MSF launches critical vaccination study')],
    usedIn: { i1: ['X'], i3: [] },
    hasVersions: true,
    staleCount: 0,
    extracting: false,
    writing: false,
    tracedItemId: null,
    onTrace: vi.fn(),
    articleSource: {
      name: 'DR Congo: MSF launches…',
      url: 'https://example.org/a',
    },
    rememberedDonationUrl: '',
    onArticleLink: vi.fn(),
    onDonationLink: vi.fn(),
    onKeyMessage: vi.fn(),
    onCallToAction: vi.fn(),
    onDecision: vi.fn(),
    onVouch: vi.fn(),
    onEditText: vi.fn(),
    onMove: vi.fn(),
    onRemove: vi.fn(),
    onAddOwn: vi.fn(),
    onOpenSource: vi.fn(),
    onPrimary: vi.fn(),
    ...partial,
  };
  render(<BriefPane {...props} />);
  return props;
}

describe('BriefPane', () => {
  it('folds the fields into one summary line once the posts are written', () => {
    renderPane();
    expect(
      screen.queryByPlaceholderText('keyMessagePlaceholder'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('summaryKeyMessage')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /briefDetails/u }));
    expect(
      screen.getByPlaceholderText('keyMessagePlaceholder'),
    ).toBeInTheDocument();
  });

  it('keeps the fields open while nothing has been written', () => {
    renderPane({ hasVersions: false });
    expect(
      screen.getByPlaceholderText('keyMessagePlaceholder'),
    ).toBeInTheDocument();
  });

  it('shows "found in source" as an icon and spells out only "not found"', () => {
    renderPane();
    expect(screen.getAllByRole('img', { name: 'foundInSource' })).toHaveLength(
      2,
    );
    expect(screen.queryByText('foundInSource')).not.toBeInTheDocument();
    expect(screen.getByText('notFoundInSource')).toBeInTheDocument();
  });

  it('shows a card as one line, and the rest only once it is selected', () => {
    renderPane();
    expect(screen.queryByText(/Amina Yusuf/u)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByText('“We had no clean water for eleven days.”'),
    );
    expect(screen.getByText(/Amina Yusuf, nurse/u)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'openSource' }),
    ).toBeInTheDocument();
    // One source: its title is not repeated on the card.
    expect(screen.queryByText(/DR Congo/u)).not.toBeInTheDocument();
    // Where it is used, as a chip; move and delete live in a menu.
    expect(screen.getByText('X')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'moveUp' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'itemActions' }));
    expect(
      screen.getByRole('menuitem', { name: /removeItem/u }),
    ).toBeInTheDocument();
  });

  it('names the source on the card only when there are several', () => {
    renderPane({
      sources: [source('a', 'First page'), source('b', 'Second page')],
    });
    fireEvent.click(
      screen.getByText('“We had no clean water for eleven days.”'),
    );
    expect(screen.getByText(/First page/u)).toBeInTheDocument();
  });

  it('marks an included item that no version uses, and can filter to those', () => {
    renderPane();
    expect(screen.getByText('notUsedShort')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /filterUnused/u }));
    expect(
      screen.getByText('The clinic treated many people.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/eleven days/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /filterNeedsYou/u }));
    expect(screen.getByText('“Nobody came.”')).toBeInTheDocument();
  });

  it('puts the shortcuts behind a button rather than on the page', () => {
    renderPane();
    expect(screen.queryByText('shortcutMove')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'shortcuts' }));
    expect(screen.getByText('shortcutMove')).toBeInTheDocument();
  });

  it('folds "from a source" and "your own" into one Add menu', () => {
    const props = renderPane();
    fireEvent.click(screen.getByRole('button', { name: /^add$/u }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'addFromSource' }));
    expect(props.onOpenSource).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^add$/u }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'addOwn' }));
    fireEvent.change(screen.getByPlaceholderText('addOwnPlaceholder'), {
      target: { value: 'My own line' },
    });
    fireEvent.submit(screen.getByPlaceholderText('addOwnPlaceholder'));
    expect(props.onAddOwn).toHaveBeenCalledWith('My own line');
  });

  it('labels the links briefly, with the explanation in a tooltip', () => {
    renderPane({ hasVersions: false });
    expect(screen.getByText('pageLink')).toBeInTheDocument();
    expect(screen.queryByText(/linksPlacementHint/u)).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /linksPlacementHint/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'donationsOffHint' }),
    ).toBeInTheDocument();
  });
});

describe('shortSpecName', () => {
  it('keeps the first word and the full name for the tooltip', () => {
    expect(shortSpecName('Instagram caption')).toBe('Instagram');
    expect(shortSpecName('X')).toBe('X');
    expect(shortSpecName('Averyveryverylongchannelname')).toBe(
      'Averyveryvery…',
    );
  });
});
