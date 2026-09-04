import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import {
  LimitDelegation,
  LimitEntry,
  LimitOverride,
} from '@/lib/services/limits/types';

import { DelegationEditor } from '@/components/Limits/DelegationEditor';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

function makeDelegation(
  partial: Partial<LimitDelegation> = {},
): LimitDelegation {
  return {
    id: 'del-0000000000aa',
    label: 'OCP',
    enabled: true,
    admins: ['ocp-admin@ocp.msf.org'],
    jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
    maxOverrides: 25,
    createdBy: 'global@msf.org',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'global@msf.org',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function makeOverride(partial: Partial<LimitOverride> = {}): LimitOverride {
  return {
    id: 'lim-0000000000a1',
    label: 'Interns',
    enabled: true,
    scope: 'user',
    targets: ['intern@ocp.msf.org'],
    priority: 0,
    delegationId: 'del-0000000000aa',
    entries: [],
    createdBy: 'ocp-admin@ocp.msf.org',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'ocp-admin@ocp.msf.org',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function renderEditor(
  delegation = makeDelegation(),
  props: {
    ownedOverrides?: LimitOverride[];
    globalDefaults?: LimitEntry[];
  } = {},
) {
  const handlers = {
    onChange: vi.fn(),
    onRemove: vi.fn(),
    onDisable: vi.fn(),
    onDeleteWithOverrides: vi.fn(),
    onLiftDefault: vi.fn(),
  };
  render(
    <DelegationEditor
      delegation={delegation}
      ownedOverrides={props.ownedOverrides ?? []}
      overlaps={[]}
      relevantRules={[]}
      labelFor={(id) => id}
      globalDefaults={props.globalDefaults ?? []}
      {...handlers}
    />,
  );
  return handlers;
}

describe('DelegationEditor', () => {
  describe('blocked delete', () => {
    it('removes directly when the delegation owns no overrides', () => {
      const h = renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'removeDelegation' }));
      expect(h.onRemove).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByText('deleteDelegationBlocked'),
      ).not.toBeInTheDocument();
    });

    /**
     * Design §6a: nothing is ever orphaned into the global tier — a
     * delegation with overrides can only be disabled or deleted WITH them.
     */
    it('blocks with the count and offers disable / delete-with-overrides', () => {
      const h = renderEditor(makeDelegation(), {
        ownedOverrides: [
          makeOverride(),
          makeOverride({ id: 'lim-0000000000a2' }),
        ],
      });
      fireEvent.click(screen.getByRole('button', { name: 'removeDelegation' }));

      expect(h.onRemove).not.toHaveBeenCalled();
      expect(screen.getByRole('alertdialog')).toHaveTextContent(
        'deleteDelegationBlocked',
      );

      fireEvent.click(
        screen.getByRole('button', { name: 'deleteDelegationDisable' }),
      );
      expect(h.onDisable).toHaveBeenCalledTimes(1);
      expect(h.onDeleteWithOverrides).not.toHaveBeenCalled();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'removeDelegation' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'deleteDelegationWithOverrides' }),
      );
      expect(h.onDeleteWithOverrides).toHaveBeenCalledTimes(1);
      expect(h.onRemove).not.toHaveBeenCalled();
    });

    it('cancel closes the offer without any handler firing', () => {
      const h = renderEditor(makeDelegation(), {
        ownedOverrides: [makeOverride()],
      });
      fireEvent.click(screen.getByRole('button', { name: 'removeDelegation' }));
      fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(h.onRemove).not.toHaveBeenCalled();
      expect(h.onDisable).not.toHaveBeenCalled();
      expect(h.onDeleteWithOverrides).not.toHaveBeenCalled();
    });
  });

  describe('jurisdiction editing', () => {
    it('changing a predicate scope resets its targets', () => {
      const h = renderEditor();
      fireEvent.change(screen.getByLabelText('delegationPredicateScopeLabel'), {
        target: { value: 'user' },
      });
      const next: LimitDelegation = h.onChange.mock.calls[0][0];
      expect(next.jurisdiction).toEqual([{ scope: 'user', targets: [] }]);
    });

    it('adds and removes predicates', () => {
      const h = renderEditor();
      fireEvent.click(
        screen.getByRole('button', { name: 'delegationAddPredicate' }),
      );
      expect(
        (h.onChange.mock.calls[0][0] as LimitDelegation).jurisdiction,
      ).toHaveLength(2);

      fireEvent.click(
        screen.getByRole('button', { name: 'delegationRemovePredicate' }),
      );
      expect(
        (h.onChange.mock.calls[1][0] as LimitDelegation).jurisdiction,
      ).toEqual([]);
    });

    it('normalizes a pasted domain entry (strips the local part)', () => {
      const h = renderEditor();
      // Two chip inputs share the add hint: admins first, then the predicate.
      const input = screen.getAllByPlaceholderText('chipAddHint')[1];
      fireEvent.change(input, { target: { value: 'someone@Paris.msf.org' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      const next: LimitDelegation = h.onChange.mock.calls[0][0];
      expect(next.jurisdiction[0].targets).toEqual([
        'ocp.msf.org',
        'Paris.msf.org',
      ]);
    });

    it('warns when the jurisdiction matches nobody', () => {
      renderEditor(
        makeDelegation({ jurisdiction: [{ scope: 'domain', targets: [] }] }),
      );
      expect(
        screen.getByText('delegationEmptyJurisdictionWarning'),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('delegationAnchorWarning'),
      ).not.toBeInTheDocument();
    });
  });

  describe('anchoring (design §8)', () => {
    it('warns on a jurisdiction with no domain or user predicate', () => {
      renderEditor(
        makeDelegation({
          jurisdiction: [
            {
              scope: 'group',
              targets: ['11111111-2222-3333-4444-555555555555'],
            },
          ],
        }),
      );
      expect(screen.getByText('delegationAnchorWarning')).toBeInTheDocument();
      expect(screen.getByText('anchorChip')).toBeInTheDocument();
    });

    it('does not warn once a domain anchors it', () => {
      renderEditor(
        makeDelegation({
          jurisdiction: [
            {
              scope: 'group',
              targets: ['11111111-2222-3333-4444-555555555555'],
            },
            { scope: 'domain', targets: ['ocp.msf.org'] },
          ],
        }),
      );
      expect(
        screen.queryByText('delegationAnchorWarning'),
      ).not.toBeInTheDocument();
    });
  });

  describe('narrowing preview (design §6a)', () => {
    it('counts owned overrides that would fall outside the drafted jurisdiction', () => {
      renderEditor(makeDelegation(), {
        ownedOverrides: [
          makeOverride(),
          makeOverride({
            id: 'lim-0000000000a2',
            targets: ['someone@paris.msf.org'],
          }),
        ],
      });
      expect(
        screen.getByText('delegationNarrowingPreview'),
      ).toBeInTheDocument();
    });

    it('is silent while every owned override is inside', () => {
      renderEditor(makeDelegation(), { ownedOverrides: [makeOverride()] });
      expect(
        screen.queryByText('delegationNarrowingPreview'),
      ).not.toBeInTheDocument();
    });
  });

  describe('admins', () => {
    it('stores admins lowercased and trimmed', () => {
      const h = renderEditor();
      // Two chip inputs share the add hint; the admins one comes first.
      const inputs = screen.getAllByPlaceholderText('chipAddHint');
      fireEvent.change(inputs[0], { target: { value: ' Bob@OCP.MSF.ORG ' } });
      fireEvent.keyDown(inputs[0], { key: 'Enter' });
      const next: LimitDelegation = h.onChange.mock.calls[0][0];
      expect(next.admins).toEqual(['ocp-admin@ocp.msf.org', 'bob@ocp.msf.org']);
    });

    it('warns when nobody is named', () => {
      renderEditor(makeDelegation({ admins: [] }));
      expect(screen.getByText('delegationNoAdminsWarning')).toBeInTheDocument();
    });
  });

  describe('liftable defaults', () => {
    it('lists global defaults without a ceiling and ticks one on click', () => {
      const liftable: LimitEntry = {
        limitKey: 'chat.messagesPerDay',
        value: 100,
        ceiling: false,
      };
      const h = renderEditor(makeDelegation(), {
        globalDefaults: [
          liftable,
          { limitKey: 'chat.tokensPerDay', value: 1000, ceiling: true },
          { limitKey: 'chat.tokensPerMonth', value: null, ceiling: false },
        ],
      });
      const buttons = screen.getAllByRole('button', {
        name: /^delegationLiftDefault /,
      });
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveAccessibleName(
        'delegationLiftDefault label.chatMessagesPerDay',
      );
      fireEvent.click(buttons[0]);
      expect(h.onLiftDefault).toHaveBeenCalledWith(liftable);
    });

    it('says so when every default already has a ceiling', () => {
      renderEditor(makeDelegation(), {
        globalDefaults: [
          { limitKey: 'chat.tokensPerDay', value: 1000, ceiling: true },
        ],
      });
      expect(screen.getByText('delegationLiftableNone')).toBeInTheDocument();
    });
  });

  it('clamps the override budget to 0..100', () => {
    const h = renderEditor();
    fireEvent.change(screen.getByLabelText('delegationMaxOverridesLabel'), {
      target: { value: '250' },
    });
    expect((h.onChange.mock.calls[0][0] as LimitDelegation).maxOverrides).toBe(
      100,
    );
  });

  it('collapses to a one-line summary', () => {
    render(
      <DelegationEditor
        delegation={makeDelegation()}
        ownedOverrides={[]}
        overlaps={[]}
        relevantRules={[]}
        labelFor={(id) => id}
        globalDefaults={[]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onDisable={vi.fn()}
        onDeleteWithOverrides={vi.fn()}
        onLiftDefault={vi.fn()}
        defaultExpanded={false}
      />,
    );
    expect(
      screen.queryByLabelText('delegationLabelLabel'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('delegationAdminsCount · delegationOverrideCount'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'expandDelegation' }));
    expect(screen.getByLabelText('delegationLabelLabel')).toBeInTheDocument();
  });
});
