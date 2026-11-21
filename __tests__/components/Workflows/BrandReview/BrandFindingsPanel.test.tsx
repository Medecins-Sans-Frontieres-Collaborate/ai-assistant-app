import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { NextIntlClientProvider } from 'next-intl';

import { BrandFinding } from '@/lib/utils/shared/brand/brandFindings';

import { BrandFindingsPanel } from '@/components/Workflows/BrandReview/BrandFindingsPanel';

import messages from '@/messages/en.json';
import { describe, expect, it, vi } from 'vitest';

/** What the findings list says when it has nothing to show. */

vi.unmock('next-intl');

function renderPanel(findings: BrandFinding[], complete?: boolean) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      onError={(error) => {
        throw error;
      }}
    >
      <BrandFindingsPanel
        findings={findings}
        complete={complete}
        selectedId={null}
        onSelect={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

describe('BrandFindingsPanel with nothing to show', () => {
  it('waits while the review runs', () => {
    renderPanel([]);
    expect(screen.getByText('Nothing found yet.')).toBeInTheDocument();
  });

  it('says nothing was found once the review has ended', () => {
    renderPanel([], true);
    expect(screen.getByText('No problems found.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing found yet.')).not.toBeInTheDocument();
  });
});

/** A check's finding of a wrong typeface in one paragraph. */
function fontFinding(unit: number, found = 'Arial'): BrandFinding {
  return {
    id: `font:u${unit}:${found.toLowerCase()}`,
    rule: 'font',
    severity: 'error',
    page: unit <= 2 ? 1 : 2,
    unitId: `u${unit}`,
    imageId: null,
    box: [10, unit * 10, 100, unit * 10 + 8],
    found,
    expected: ['Avenir Next'],
    source: 'check',
  };
}

/** The panel holding its own selection, as the workspace does. */
function SelectingPanel({ findings }: { findings: BrandFinding[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <BrandFindingsPanel
        findings={findings}
        complete
        selectedId={selected}
        onSelect={(finding) => setSelected(finding.id)}
      />
      <output>{selected}</output>
    </NextIntlClientProvider>
  );
}

describe('BrandFindingsPanel with one problem in several places', () => {
  const findings = [
    fontFinding(1),
    fontFinding(2),
    fontFinding(3),
    fontFinding(4, 'Calibri'),
  ];

  it('lists a repeated problem once with its places, and a single one alone', () => {
    render(<SelectingPanel findings={findings} />);
    expect(screen.getAllByText(/^Set in Arial/)).toHaveLength(1);
    expect(screen.getByText('3 places')).toBeInTheDocument();
    // The single Calibri finding shows its page, not a count of places.
    expect(screen.getByText('p. 2')).toBeInTheDocument();
    // The filter still counts every place.
    expect(screen.getByRole('radio', { name: 'Errors 4' })).toBeInTheDocument();
  });

  it('steps through the places, and round from the last to the first', () => {
    render(<SelectingPanel findings={findings} />);
    expect(
      screen.queryByRole('button', { name: 'Next place' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/^Set in Arial/));
    expect(screen.getByRole('status')).toHaveTextContent('font:u1:arial');
    expect(screen.getByText(/1 of 3/)).toBeInTheDocument();

    const next = screen.getByRole('button', { name: 'Next place' });
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByRole('status')).toHaveTextContent('font:u3:arial');
    expect(screen.getByText(/3 of 3/)).toHaveTextContent('p. 2');
    fireEvent.click(next);
    expect(screen.getByRole('status')).toHaveTextContent('font:u1:arial');
    fireEvent.click(screen.getByRole('button', { name: 'Previous place' }));
    expect(screen.getByRole('status')).toHaveTextContent('font:u3:arial');
  });
});
