import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { LimitEntry, LimitOverride } from '@/lib/services/limits/types';

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

function renderEditor(
  override = makeOverride(),
  extraProps: {
    globalDefaults?: LimitEntry[];
    defaultExpanded?: boolean;
  } = {},
) {
  const onChange = vi.fn();
  render(
    <OverrideEditor
      override={override}
      onChange={onChange}
      onRemove={vi.fn()}
      {...extraProps}
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

    // Rows render in group order: chat.messagesPerDay first, the tts row
    // second. Edit the TTS row so chat.messagesPerDay is genuinely
    // untouched by this change.
    const selects = screen.getAllByLabelText('valueModeLabel');
    fireEvent.change(selects[1], { target: { value: 'blocked' } });

    expect(onChange).toHaveBeenCalled();
    const next: LimitOverride = onChange.mock.calls[0][0];
    const preserved = next.entries.find(
      (e) => e.limitKey === 'chat.messagesPerDay',
    );
    expect(preserved?.ceiling).toBe(true);
  });

  it('does not invent a ceiling on entries that never had one', () => {
    const onChange = renderEditor();
    // Edit chat.messagesPerDay; the tts entry must keep ceiling: false.
    const selects = screen.getAllByLabelText('valueModeLabel');
    fireEvent.change(selects[0], { target: { value: 'blocked' } });

    const next: LimitOverride = onChange.mock.calls[0][0];
    const untouched = next.entries.find(
      (e) => e.limitKey === 'feature.tts.charactersPerDay',
    );
    expect(untouched?.ceiling).toBe(false);
  });

  it('keeps every previously stored entry after an edit, including unknown keys', () => {
    const onChange = renderEditor(
      makeOverride({
        entries: [
          { limitKey: 'chat.messagesPerDay', value: 100, ceiling: true },
          {
            limitKey: 'feature.tts.charactersPerDay',
            value: 5000,
            ceiling: false,
          },
          // Written by a NEWER app version: this build's catalog does not
          // know the key, but an edit here must not destroy it.
          { limitKey: 'future.unknownThing', value: 3, ceiling: true },
        ],
      }),
    );
    const selects = screen.getAllByLabelText('valueModeLabel');
    fireEvent.change(selects[0], { target: { value: 'blocked' } });

    const next: LimitOverride = onChange.mock.calls[0][0];
    for (const key of [
      'chat.messagesPerDay',
      'feature.tts.charactersPerDay',
      'future.unknownThing',
    ]) {
      expect(next.entries.some((e) => e.limitKey === key)).toBe(true);
    }
    expect(
      next.entries.find((e) => e.limitKey === 'future.unknownThing')?.ceiling,
    ).toBe(true);
  });

  it('lists unknown keys read-only instead of hiding them', () => {
    renderEditor(
      makeOverride({
        entries: [{ limitKey: 'future.unknownThing', value: 3, ceiling: true }],
      }),
    );
    expect(screen.getByText('unrecognizedEntries')).toBeInTheDocument();
    expect(screen.getByText('future.unknownThing')).toBeInTheDocument();
  });

  it('renders the pending-consent notice for the group scope and disables its targets', () => {
    renderEditor(makeOverride({ scope: 'group', targets: [] }));
    expect(screen.getByText('groupsPendingConsent')).toBeInTheDocument();
  });

  it('does not show the pending-consent notice for an attribute override', () => {
    renderEditor(makeOverride({ scope: 'attribute' }));
    expect(screen.queryByText('groupsPendingConsent')).not.toBeInTheDocument();
  });

  describe('configured-only rendering', () => {
    it('renders only the limits the override sets, not the whole catalog', () => {
      renderEditor();
      // Two configured entries → exactly two value controls.
      expect(screen.getAllByLabelText('valueModeLabel')).toHaveLength(2);
      // Unconfigured limits appear only as add-picker <option>s, never as
      // rows (row labels render in divs).
      expect(
        screen.queryByText('label.codeInterpreterEnabled', {
          selector: 'div',
        }),
      ).not.toBeInTheDocument();
    });

    it('keeps a row whose only entries are model-scoped cells', () => {
      renderEditor(
        makeOverride({
          entries: [
            {
              limitKey: 'model.requests',
              modelId: 'gpt-5.2',
              value: 50,
              ceiling: false,
            },
          ],
        }),
      );
      expect(
        screen.getByText('label.modelRequestsPerDay', { selector: 'div' }),
      ).toBeInTheDocument();
    });

    it('adding a limit seeds a safe value and preserves existing entries', () => {
      const onChange = renderEditor();
      fireEvent.change(screen.getByLabelText('addLimitLabel'), {
        target: { value: 'feature.mcp.roundsPerRequest' },
      });

      const next: LimitOverride = onChange.mock.calls[0][0];
      const added = next.entries.find(
        (e) => e.limitKey === 'feature.mcp.roundsPerRequest',
      );
      // Clamped to the compiled hard ceiling (25), never null/unlimited.
      expect(added?.value).toBe(25);
      expect(
        next.entries.find((e) => e.limitKey === 'chat.messagesPerDay')?.ceiling,
      ).toBe(true);
    });

    it('adding a feature gate seeds blocked, never allowed', () => {
      const onChange = renderEditor();
      fireEvent.change(screen.getByLabelText('addLimitLabel'), {
        target: { value: 'feature.webSearch.enabled' },
      });

      const next: LimitOverride = onChange.mock.calls[0][0];
      expect(
        next.entries.find((e) => e.limitKey === 'feature.webSearch.enabled')
          ?.value,
      ).toBe(false);
    });

    it('switching a row to inherit removes exactly that entry', () => {
      const onChange = renderEditor();
      const selects = screen.getAllByLabelText('valueModeLabel');
      fireEvent.change(selects[1], { target: { value: 'inherit' } });

      const next: LimitOverride = onChange.mock.calls[0][0];
      expect(
        next.entries.some((e) => e.limitKey === 'feature.tts.charactersPerDay'),
      ).toBe(false);
      expect(
        next.entries.some((e) => e.limitKey === 'chat.messagesPerDay'),
      ).toBe(true);
    });
  });

  describe('gate-off awareness', () => {
    it('warns when a configured cap targets a feature turned off globally, without disabling inputs', () => {
      renderEditor(
        makeOverride({
          entries: [
            {
              limitKey: 'feature.webSearch.callsPerDay',
              value: 10,
              ceiling: false,
            },
          ],
        }),
        {
          globalDefaults: [
            {
              limitKey: 'feature.webSearch.enabled',
              value: false,
              ceiling: false,
            },
          ],
        },
      );

      expect(screen.getByText('overrideGateOffNote')).toBeInTheDocument();
      // Layered resolution means another override could re-enable the
      // gate, so the cap stays editable.
      for (const select of screen.getAllByLabelText('valueModeLabel')) {
        expect(select).not.toBeDisabled();
      }
    });

    it('does not warn when the override itself re-enables the gate', () => {
      renderEditor(
        makeOverride({
          entries: [
            {
              limitKey: 'feature.webSearch.enabled',
              value: true,
              ceiling: false,
            },
            {
              limitKey: 'feature.webSearch.callsPerDay',
              value: 10,
              ceiling: false,
            },
          ],
        }),
        {
          globalDefaults: [
            {
              limitKey: 'feature.webSearch.enabled',
              value: false,
              ceiling: false,
            },
          ],
        },
      );

      expect(screen.queryByText('overrideGateOffNote')).not.toBeInTheDocument();
    });
  });

  describe('collapsed cards', () => {
    it('renders a summary with no value controls until expanded', () => {
      renderEditor(makeOverride(), { defaultExpanded: false });

      expect(screen.getByText('Contractors')).toBeInTheDocument();
      expect(
        screen.getByText('targetsCount · limitsCount'),
      ).toBeInTheDocument();
      expect(screen.queryAllByLabelText('valueModeLabel')).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: 'expandOverride' }));
      expect(screen.getAllByLabelText('valueModeLabel')).toHaveLength(2);
    });
  });

  describe('priority', () => {
    it('round-trips the priority field', () => {
      const onChange = renderEditor();
      fireEvent.change(screen.getByLabelText('priorityLabel'), {
        target: { value: '250' },
      });
      const next: LimitOverride = onChange.mock.calls[0][0];
      expect(next.priority).toBe(250);
    });
  });
});
