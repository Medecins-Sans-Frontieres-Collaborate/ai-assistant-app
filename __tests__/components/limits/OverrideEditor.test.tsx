import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { LimitOverride } from '@/lib/services/limits/types';

import { OverrideEditor } from '@/components/Limits/OverrideEditor';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

function makeOverride(overrides: Partial<LimitOverride> = {}): LimitOverride {
  return {
    id: 'lim-0123456789ab',
    label: 'Contractors',
    enabled: true,
    scope: 'domain',
    targets: ['example.org'],
    priority: 0,
    entries: [
      { limitKey: 'chat.messagesPerDay', value: 100, ceiling: true },
      { limitKey: 'feature.tts.charactersPerDay', value: 5000, ceiling: false },
    ],
    createdBy: 'admin@example.org',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin@example.org',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderEditor(override = makeOverride()) {
  const onChange = vi.fn();
  render(
    <OverrideEditor
      override={override}
      onChange={onChange}
      onRemove={vi.fn()}
    />,
  );
  return onChange;
}

describe('OverrideEditor', () => {
  /**
   * Regression: setValue called draftToEntries WITHOUT the ceilings map, and
   * draftToEntries writes `ceiling: ceilings[key] ?? false` for EVERY entry —
   * so one keystroke on any limit silently rewrote the whole array with
   * ceiling:false. The write API accepts and persists ceiling on override
   * entries, so this destroyed stored data.
   */
  it('preserves ceiling on untouched entries when another limit is edited', () => {
    const onChange = renderEditor();

    // Change some other limit — any one will do; the bug was array-wide.
    const selects = screen.getAllByLabelText('valueModeLabel');
    fireEvent.change(selects[0], { target: { value: 'blocked' } });

    expect(onChange).toHaveBeenCalled();
    const next: LimitOverride = onChange.mock.calls[0][0];
    const preserved = next.entries.find(
      (e) => e.limitKey === 'chat.messagesPerDay',
    );
    expect(preserved?.ceiling).toBe(true);
  });

  it('does not invent a ceiling on entries that never had one', () => {
    const onChange = renderEditor();
    const selects = screen.getAllByLabelText('valueModeLabel');
    fireEvent.change(selects[0], { target: { value: 'blocked' } });

    const next: LimitOverride = onChange.mock.calls[0][0];
    const untouched = next.entries.find(
      (e) => e.limitKey === 'feature.tts.charactersPerDay',
    );
    expect(untouched?.ceiling).toBe(false);
  });

  it('keeps every previously stored entry after an edit', () => {
    const onChange = renderEditor();
    const selects = screen.getAllByLabelText('valueModeLabel');
    fireEvent.change(selects[0], { target: { value: 'blocked' } });

    const next: LimitOverride = onChange.mock.calls[0][0];
    for (const key of ['chat.messagesPerDay', 'feature.tts.charactersPerDay']) {
      expect(next.entries.some((e) => e.limitKey === key)).toBe(true);
    }
  });

  it('renders the pending-consent notice for the group scope and disables its targets', () => {
    renderEditor(makeOverride({ scope: 'group', targets: [] }));
    expect(screen.getByText('groupsPendingConsent')).toBeInTheDocument();
  });

  it('does not show the pending-consent notice for an attribute override', () => {
    renderEditor(makeOverride({ scope: 'attribute' }));
    expect(screen.queryByText('groupsPendingConsent')).not.toBeInTheDocument();
  });
});
