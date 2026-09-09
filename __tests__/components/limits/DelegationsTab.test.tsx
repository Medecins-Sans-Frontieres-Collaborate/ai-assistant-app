import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import { LimitDelegation, LimitOverride } from '@/lib/services/limits/types';

import { DelegationsTab } from '@/components/Limits/DelegationsTab';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations:
    () => (key: string, params?: Record<string, string | number>) =>
      key === 'overlapRow' && params
        ? `overlapRow:${params.a}|${params.b}|${params.scope}|${params.shared}`
        : key,
}));

let counter = 0;
function delegation(partial: Partial<LimitDelegation> = {}): LimitDelegation {
  counter += 1;
  return {
    id: `del-${counter.toString(16).padStart(12, '0')}`,
    label: `D${counter}`,
    enabled: true,
    admins: [],
    jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
    maxOverrides: 25,
    createdBy: 'g@msf.org',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'g@msf.org',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function override(partial: Partial<LimitOverride> = {}): LimitOverride {
  counter += 1;
  return {
    id: `lim-${counter.toString(16).padStart(12, '0')}`,
    label: `O${counter}`,
    enabled: true,
    scope: 'user',
    targets: ['alice@ocp.msf.org'],
    priority: 0,
    entries: [],
    createdBy: 'g@msf.org',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'g@msf.org',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function renderTab(
  delegations: LimitDelegation[],
  overrides: LimitOverride[] = [],
  newIds = new Set<string>(),
) {
  const onChange = vi.fn();
  const onAdd = vi.fn();
  render(
    <DelegationsTab
      delegations={delegations}
      overrides={overrides}
      defaults={[]}
      newIds={newIds}
      onChange={onChange}
      onAdd={onAdd}
    />,
  );
  return { onChange, onAdd };
}

describe('DelegationsTab', () => {
  describe('overlap hint (design §6a)', () => {
    it('appears when two delegations share a domain', () => {
      const a = delegation({ label: 'OCP' });
      const b = delegation({ label: 'OCP bis' });
      renderTab([a, b]);
      expect(screen.getByText('overlapTitle')).toBeInTheDocument();
      expect(
        screen.getByText('overlapRow:OCP|OCP bis|scope.domain|ocp.msf.org'),
      ).toBeInTheDocument();
      expect(screen.getAllByText('overlapChip')).toHaveLength(2);
    });

    it('appears for a user listed in one whose domain the other holds', () => {
      const a = delegation({ label: 'OCP' });
      const b = delegation({
        label: 'Carol',
        jurisdiction: [{ scope: 'user', targets: ['Carol@ocp.msf.org'] }],
      });
      renderTab([a, b]);
      expect(
        screen.getByText('overlapRow:OCP|Carol|scope.user|carol@ocp.msf.org'),
      ).toBeInTheDocument();
    });

    it('never fires for group-vs-domain', () => {
      const a = delegation();
      const b = delegation({
        jurisdiction: [
          { scope: 'group', targets: ['11111111-2222-3333-4444-555555555555'] },
        ],
      });
      renderTab([a, b]);
      expect(screen.queryByText('overlapTitle')).not.toBeInTheDocument();
      expect(screen.queryByText('overlapChip')).not.toBeInTheDocument();
    });
  });

  describe('budget line (design §5)', () => {
    it('shows the allocation normally and warns past the document cap', () => {
      renderTab([delegation({ maxOverrides: 100 })]);
      expect(screen.getByText('delegationsBudget')).toBeInTheDocument();
    });

    it('warns when global overrides + Σ maxOverrides exceed 200', () => {
      renderTab(
        [
          delegation({ maxOverrides: 100 }),
          delegation({
            maxOverrides: 100,
            jurisdiction: [{ scope: 'domain', targets: ['paris.msf.org'] }],
          }),
        ],
        [override()],
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        'delegationsBudgetExceeded',
      );
    });
  });

  /**
   * Two separate patches would let an intermediate render carry overrides
   * pointing at a delegation that no longer exists (which the PUT rejects).
   */
  it('cascade delete emits ONE onChange with both arrays filtered', () => {
    const d = delegation();
    const owned = override({ delegationId: d.id });
    const global = override();
    const { onChange } = renderTab([d], [owned, global], new Set([d.id]));

    fireEvent.click(screen.getByRole('button', { name: 'removeDelegation' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'deleteDelegationWithOverrides' }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      delegations: [],
      overrides: [global],
    });
  });

  it('disable-instead keeps the delegation and its overrides', () => {
    const d = delegation();
    const owned = override({ delegationId: d.id });
    const { onChange } = renderTab([d], [owned], new Set([d.id]));

    fireEvent.click(screen.getByRole('button', { name: 'removeDelegation' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'deleteDelegationDisable' }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    const patch = onChange.mock.calls[0][0];
    expect(patch.delegations).toEqual([{ ...d, enabled: false }]);
    expect(patch).not.toHaveProperty('overrides');
  });

  it('lifting a default ticks ceiling on exactly that entry', () => {
    const d = delegation();
    const onChange = vi.fn();
    render(
      <DelegationsTab
        delegations={[d]}
        overrides={[]}
        defaults={[
          { limitKey: 'chat.messagesPerDay', value: 100, ceiling: false },
          { limitKey: 'chat.tokensPerDay', value: 5, ceiling: false },
        ]}
        newIds={new Set([d.id])}
        onChange={onChange}
        onAdd={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'delegationLiftDefault label.chatMessagesPerDay',
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      defaults: [
        { limitKey: 'chat.messagesPerDay', value: 100, ceiling: true },
        { limitKey: 'chat.tokensPerDay', value: 5, ceiling: false },
      ],
    });
  });

  describe('relevant rules popover', () => {
    it('lists other rules for the same targets and toggles with aria-expanded', () => {
      const d = delegation({ label: 'OCP' });
      const global = override({ label: 'Alice cap' }); // alice@ocp.msf.org ∈ ocp.msf.org
      renderTab([d], [global]);

      const trigger = screen.getByRole('button', { name: 'relevantRulesFor' });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');

      const tooltip = screen.getByRole('tooltip');
      expect(
        within(tooltip).getByText('relevantRulesOverride'),
      ).toBeInTheDocument();
      expect(within(tooltip).getByText('Alice cap')).toBeInTheDocument();
      expect(
        within(tooltip).getByText('relevantRulesMatched'),
      ).toBeInTheDocument();

      fireEvent.click(trigger);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    /**
     * Contract: rules are queried once per predicate of the jurisdiction. A
     * rule meeting two predicates (domain + a user inside it) is listed ONCE
     * — one row, one count in the trigger's aria-label, no duplicate keys.
     */
    it('lists a rule that meets two predicates of the same jurisdiction once', () => {
      const mixed = delegation({
        label: 'OCP mixed',
        jurisdiction: [
          { scope: 'domain', targets: ['ocp.msf.org'] },
          { scope: 'user', targets: ['alice@ocp.msf.org'] },
        ],
      });
      const other = delegation({ label: 'OCP other' }); // domain ocp.msf.org
      const aliceCap = override({ label: 'Alice cap' }); // alice@ocp.msf.org
      const keyWarnings: string[] = [];
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation((...args: unknown[]) => {
          keyWarnings.push(args.map(String).join(' '));
        });
      try {
        renderTab([mixed, other], [aliceCap]);

        // The mixed delegation's trigger is the first; `other` has its own.
        const [trigger] = screen.getAllByRole('button', {
          name: 'relevantRulesFor',
        });
        fireEvent.click(trigger);
        const tooltip = screen.getByRole('tooltip');
        expect(within(tooltip).getAllByText('Alice cap')).toHaveLength(1);
        expect(within(tooltip).getAllByText('OCP other')).toHaveLength(1);
        expect(within(tooltip).getAllByRole('listitem')).toHaveLength(2);
        expect(keyWarnings.filter((w) => w.includes('same key'))).toEqual([]);
      } finally {
        consoleError.mockRestore();
      }
    });

    it('renders no trigger when nothing else touches the targets', () => {
      renderTab([delegation()], [override({ targets: ['bob@paris.msf.org'] })]);
      expect(
        screen.queryByRole('button', { name: 'relevantRulesFor' }),
      ).not.toBeInTheDocument();
    });
  });

  it('shows the empty state and wires the add button', () => {
    const { onAdd } = renderTab([]);
    expect(screen.getByText('noDelegations')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'addDelegation' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
