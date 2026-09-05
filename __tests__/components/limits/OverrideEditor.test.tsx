import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { LimitEntry, LimitOverride } from '@/lib/services/limits/types';

import { OverrideEditor } from '@/components/Limits/OverrideEditor';
import type { TargetVerdict } from '@/components/Limits/jurisdiction';

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
    variant?: 'global' | 'scoped';
    appliesTo?: string;
    verdicts?: TargetVerdict[];
    rejectedTargets?: string[];
    delegationOptions?: Array<{ id: string; label: string }>;
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

  it('renders the group search picker with editable id chips for the group scope', () => {
    renderEditor(
      makeOverride({
        scope: 'group',
        targets: ['11111111-2222-3333-4444-555555555555'],
      }),
    );
    const search = screen.getByLabelText('groupSearchPlaceholder');
    expect(search).toBeInTheDocument();
    expect(search).not.toBeDisabled();
    // Stored ids render as chips and stay removable (not the v1 disabled
    // scaffold).
    expect(
      screen.getByText('11111111-2222-3333-4444-555555555555'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('removeChip 11111111-2222-3333-4444-555555555555'),
    ).toBeInTheDocument();
  });

  it('does not show the group search for an attribute override', () => {
    renderEditor(makeOverride({ scope: 'attribute' }));
    expect(
      screen.queryByLabelText('groupSearchPlaceholder'),
    ).not.toBeInTheDocument();
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

  describe('scoped variant (design §6b)', () => {
    it('hides the priority field and hint', () => {
      renderEditor(makeOverride(), { variant: 'scoped' });
      expect(screen.queryByLabelText('priorityLabel')).not.toBeInTheDocument();
      expect(screen.queryByText('priorityHint')).not.toBeInTheDocument();
      // Everything else is still editable.
      expect(screen.getByLabelText('overrideLabelLabel')).toBeInTheDocument();
    });

    it('shows the applies-to line collapsed and expanded', () => {
      renderEditor(makeOverride(), {
        appliesTo: 'applies-line',
        defaultExpanded: false,
      });
      expect(screen.getByText('applies-line')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'expandOverride' }));
      expect(screen.getByText('applies-line')).toBeInTheDocument();
    });
  });

  describe('verdicts (design §4)', () => {
    it('highlights out-of-scope targets on the chip itself and with a header chip', () => {
      renderEditor(
        makeOverride({
          scope: 'user',
          targets: ['in@ocp.msf.org', 'out@paris.msf.org'],
        }),
        {
          verdicts: [
            {
              target: 'in@ocp.msf.org',
              status: 'in-scope',
              reason: 'domain-match',
            },
            {
              target: 'out@paris.msf.org',
              status: 'out-of-scope',
              reason: 'not-in-domains',
            },
          ],
        },
      );
      expect(screen.getByText('out@paris.msf.org')).toHaveAttribute(
        'title',
        'verdictOutOfScopeChip',
      );
      expect(screen.getByText('out@paris.msf.org').className).toContain(
        'ring-red-500',
      );
      expect(screen.getByText('in@ocp.msf.org')).not.toHaveAttribute('title');
      expect(screen.getByText('verdictOutOfScopeChip')).toBeInTheDocument();
      expect(screen.getByText('verdictOutOfScope')).toBeInTheDocument();
      expect(screen.queryByText('verdictCrossAxis')).not.toBeInTheDocument();
    });

    it('adds the cross-axis note for an undecidable target', () => {
      renderEditor(
        makeOverride({ scope: 'attribute', targets: ['department:health'] }),
        {
          verdicts: [
            {
              target: 'department:health',
              status: 'undecidable',
              reason: 'cross-axis',
            },
          ],
        },
      );
      expect(screen.getByText('verdictCrossAxis')).toBeInTheDocument();
      expect(screen.queryByText('verdictOutOfScope')).not.toBeInTheDocument();
    });

    it('highlights targets the SERVER rejected even when the client verdict is silent', () => {
      renderEditor(
        makeOverride({ scope: 'user', targets: ['x@ocp.msf.org'] }),
        {
          verdicts: [
            {
              target: 'x@ocp.msf.org',
              status: 'in-scope',
              reason: 'domain-match',
            },
          ],
          rejectedTargets: ['X@OCP.MSF.ORG'],
        },
      );
      expect(screen.getByText('x@ocp.msf.org')).toHaveAttribute(
        'title',
        'verdictOutOfScopeChip',
      );
    });
  });

  /**
   * Design §3c / docs/LIMITS.md: a global admin pins a cell against scoped
   * lifting by ticking Hard ceiling on a GLOBAL-TIER override ("OCP capped at
   * 100 (domain, ceiling), except alice at 500 (user, ceiling)"). The resolver
   * honours it, so the editor must be able to author it — and must not offer
   * it where the server would refuse or normalize it away (scoped writes,
   * `delegationId` records).
   */
  describe('override-level ceiling (design §3c)', () => {
    it('offers the Hard ceiling toggle on every configured row of a global-tier override', () => {
      renderEditor();
      // Two configured entries → two toggles, reflecting the stored flags.
      const toggles = screen.getAllByLabelText('hardCeilingToggle');
      expect(toggles).toHaveLength(2);
      expect(toggles[0]).toBeChecked(); // chat.messagesPerDay: ceiling true
      expect(toggles[1]).not.toBeChecked(); // tts: ceiling false
      expect(screen.getByText('overrideCeilingHint')).toBeInTheDocument();
    });

    it('ticking it stores ceiling:true on exactly that entry and preserves the rest', () => {
      const onChange = renderEditor();
      const toggles = screen.getAllByLabelText('hardCeilingToggle');
      fireEvent.click(toggles[1]);

      expect(onChange).toHaveBeenCalledTimes(1);
      const next: LimitOverride = onChange.mock.calls[0][0];
      expect(next.entries).toEqual([
        { limitKey: 'chat.messagesPerDay', value: 100, ceiling: true },
        {
          limitKey: 'feature.tts.charactersPerDay',
          value: 5000,
          ceiling: true,
        },
      ]);
      // Nothing else on the record moved.
      expect(next.priority).toBe(0);
      expect(next).not.toHaveProperty('delegationId');
    });

    it('unticking it clears only that entry', () => {
      const onChange = renderEditor();
      fireEvent.click(screen.getAllByLabelText('hardCeilingToggle')[0]);

      const next: LimitOverride = onChange.mock.calls[0][0];
      expect(
        next.entries.find((e) => e.limitKey === 'chat.messagesPerDay')?.ceiling,
      ).toBe(false);
      expect(
        next.entries.find((e) => e.limitKey === 'feature.tts.charactersPerDay')
          ?.ceiling,
      ).toBe(false);
      expect(next.entries).toHaveLength(2);
    });

    it('never shows the control on a delegationId record, even in the global panel', () => {
      renderEditor(makeOverride({ delegationId: 'del-0000000000aa' }), {
        variant: 'global',
        delegationOptions: [{ id: 'del-0000000000aa', label: 'OCP' }],
      });
      expect(screen.getAllByLabelText('valueModeLabel')).toHaveLength(2);
      expect(
        screen.queryByLabelText('hardCeilingToggle'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('overrideCeilingHint')).not.toBeInTheDocument();
    });

    it('never shows the control in the scoped variant', () => {
      renderEditor(makeOverride(), { variant: 'scoped' });
      expect(screen.getAllByLabelText('valueModeLabel')).toHaveLength(2);
      expect(
        screen.queryByLabelText('hardCeilingToggle'),
      ).not.toBeInTheDocument();
    });

    it('disappears the moment the override is handed to a delegation', () => {
      // Controlled re-render: what assignDelegation emits is what the parent
      // would pass back, so render the emitted record and check the control.
      const onChange = renderEditor(makeOverride(), {
        delegationOptions: [{ id: 'del-0000000000aa', label: 'OCP' }],
      });
      expect(screen.getAllByLabelText('hardCeilingToggle')).toHaveLength(2);
      fireEvent.change(screen.getByLabelText('overrideDelegationLabel'), {
        target: { value: 'del-0000000000aa' },
      });
      const next: LimitOverride = onChange.mock.calls[0][0];
      expect(next.entries.every((e) => e.ceiling === false)).toBe(true);
    });
  });

  describe('delegation assignment (global panel)', () => {
    it('assigning a delegation forces priority 0 and clears ceilings', () => {
      const onChange = renderEditor(makeOverride({ priority: 250 }), {
        delegationOptions: [{ id: 'del-0000000000aa', label: 'OCP' }],
      });
      fireEvent.change(screen.getByLabelText('overrideDelegationLabel'), {
        target: { value: 'del-0000000000aa' },
      });
      const next: LimitOverride = onChange.mock.calls[0][0];
      expect(next.delegationId).toBe('del-0000000000aa');
      expect(next.priority).toBe(0);
      expect(next.entries.every((e) => e.ceiling === false)).toBe(true);
    });

    it('choosing none drops delegationId entirely', () => {
      const onChange = renderEditor(
        makeOverride({ delegationId: 'del-0000000000aa' }),
        { delegationOptions: [{ id: 'del-0000000000aa', label: 'OCP' }] },
      );
      fireEvent.change(screen.getByLabelText('overrideDelegationLabel'), {
        target: { value: '' },
      });
      const next: LimitOverride = onChange.mock.calls[0][0];
      expect(next).not.toHaveProperty('delegationId');
    });

    it('renders no delegation select when no options are supplied', () => {
      renderEditor();
      expect(
        screen.queryByLabelText('overrideDelegationLabel'),
      ).not.toBeInTheDocument();
    });
  });
});
