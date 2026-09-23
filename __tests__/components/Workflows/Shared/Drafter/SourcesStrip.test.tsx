import { fireEvent, render, screen } from '@testing-library/react';

import { DraftSource } from '@/types/drafter';

import { SourcesStrip } from '@/components/Workflows/ChannelDrafter/SourcesStrip';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const source: DraftSource = {
  id: 'a',
  kind: 'url',
  name: 'Ebola in DR Congo: the outbreak is not shrinking',
  url: 'https://example.org/a',
  chars: 100,
  addedAt: '2026-09-22T00:00:00.000Z',
};

// The jsdom i18n mock has no workflows namespace: labels render as raw keys.
function renderStrip(onAddUrl = vi.fn(), onAddFromM365?: () => void) {
  render(
    <SourcesStrip
      sources={[source]}
      busy={false}
      onAddFile={vi.fn()}
      onAddUrl={onAddUrl}
      onAddNote={vi.fn()}
      onAddFromM365={onAddFromM365}
      onRemove={vi.fn()}
    />,
  );
  return onAddUrl;
}

describe('SourcesStrip', () => {
  it('is one line: a count, the sources, and one add button', () => {
    renderStrip();
    expect(screen.getByText('sourcesCount')).toBeInTheDocument();
    expect(screen.getByText(/Ebola in DR Congo/u)).toBeInTheDocument();
    expect(screen.queryByText('addFile')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'addSource' }),
    ).toBeInTheDocument();
  });

  it('keeps the four ways to add behind the button, OneDrive only when connected', () => {
    const onAddUrl = renderStrip(vi.fn(), () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'addSource' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
    fireEvent.click(screen.getByRole('menuitem', { name: 'addUrl' }));
    const input = screen.getByLabelText('addUrl');
    fireEvent.change(input, { target: { value: 'https://example.org/b' } });
    fireEvent.submit(input);
    expect(onAddUrl).toHaveBeenCalledWith('https://example.org/b');
  });
});
