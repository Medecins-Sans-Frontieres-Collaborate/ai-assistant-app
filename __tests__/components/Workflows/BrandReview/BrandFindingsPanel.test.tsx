import { render, screen } from '@testing-library/react';

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
