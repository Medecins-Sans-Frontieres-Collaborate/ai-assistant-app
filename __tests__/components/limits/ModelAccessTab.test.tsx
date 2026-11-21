import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';

import { NextIntlClientProvider } from 'next-intl';

import type { ModelAccessRule } from '@/lib/services/limits/types';

import { ModelAccessTab } from '@/components/Limits/ModelAccessTab';

import { useSettingsStore } from '@/client/stores/settingsStore';
import messages from '@/messages/en.json';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real English messages: a missing key or bad ICU throws.
vi.unmock('next-intl');
vi.mock('launchdarkly-react-client-sdk', () => ({ useFlags: () => ({}) }));
vi.mock('@/client/hooks/useM365PeopleSuggest', () => ({
  useM365PeopleSuggest: () => undefined,
}));
const GROUP_ID = '11111111-2222-3333-4444-555555555555';
vi.mock('@/client/services/m365/m365Client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  lookupEntraGroups: vi.fn().mockResolvedValue([]),
  searchEntraGroups: vi
    .fn()
    .mockResolvedValue([
      { id: '11111111-2222-3333-4444-555555555555', name: 'Research pilot' },
    ]),
}));
// The group search is flag-gated (with a localhost hatch jsdom also takes).
vi.mock('@/client/hooks/useAgentAccessGroupsEnabled', () => ({
  useAgentAccessGroupsEnabled: () => true,
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      onError={(error) => {
        throw error;
      }}
    >
      {children}
    </NextIntlClientProvider>
  </QueryClientProvider>
);

function renderTab(
  rules: ModelAccessRule[] = [],
  mode: 'observe' | 'enforce' = 'enforce',
  defaults: React.ComponentProps<typeof ModelAccessTab>['defaults'] = [],
) {
  const onChange = vi.fn();
  render(
    <ModelAccessTab
      rules={rules}
      defaults={defaults}
      onChange={onChange}
      mode={mode}
    />,
    { wrapper },
  );
  return onChange;
}

function rule(partial: Partial<ModelAccessRule>): ModelAccessRule {
  return { groups: [], domains: [], allow: [], deny: [], ...partial };
}

/** A grid cell, by its accessible name "<row>, <column>: <value>". */
const cell = (name: string | RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  useSettingsStore.setState({ models: [] });
});

describe('ModelAccessTab grid', () => {
  it('shows the Claude family as unavailable to everyone else by default', () => {
    renderTab();
    expect(
      cell('Claude, Everyone else: Unavailable, inherited'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Models hosted outside the Azure environment/),
    ).toHaveTextContent('Claude');
    // Closed by default with nobody listed.
    const row = screen
      .getByRole('rowheader', { name: /^Claude.*family: shared/ })
      .closest('tr');
    expect(within(row as HTMLElement).getByText('Nobody')).toBeInTheDocument();
  });

  it('shows the observe-mode note only in observe mode', () => {
    renderTab([], 'observe');
    expect(screen.getByText(/Observe mode is on/)).toBeInTheDocument();
  });

  it('says nothing about observe mode when enforcing', () => {
    renderTab([], 'enforce');
    expect(screen.queryByText(/Observe mode is on/)).not.toBeInTheDocument();
  });

  it('edits a family default from its row with the shared four-way control', () => {
    const onChange = renderTab();
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    const editor = screen.getByRole('region', { name: 'Who can use Claude' });
    const control = within(editor).getByRole('radiogroup', {
      name: /^Claude, Everyone else/,
    });
    expect(
      within(control)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Inherit', 'Limit', 'Unlimited', 'Off']);
    fireEvent.click(within(control).getByLabelText('Unlimited'));
    expect(onChange).toHaveBeenLastCalledWith([
      rule({ series: 'claude', defaultAccess: null }),
    ]);
    // Off is stored as "unavailable" (false), never as a cap of 0.
    fireEvent.click(within(control).getByLabelText('Off'));
    expect(onChange).toHaveBeenLastCalledWith([
      rule({ series: 'claude', defaultAccess: false }),
    ]);
  });

  it('adds a person, a domain and a group in one go, on the same terms', async () => {
    const onChange = renderTab();
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    const editor = screen.getByRole('region', { name: 'Who can use Claude' });
    const field = within(editor).getByRole('combobox', {
      name: 'People, groups or domains to add',
    });
    // Typed: a mail and a domain, pasted as one list.
    fireEvent.change(field, { target: { value: 'ana@msf.org, oca.msf.org' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    // Searched: a group from the directory.
    fireEvent.change(field, { target: { value: 'research' } });
    const option = await screen.findByRole('option', {
      name: /Research pilot/,
    });
    fireEvent.mouseDown(option);

    const terms = within(editor).getByRole('radiogroup', {
      name: 'What the people, groups and domains being added get',
    });
    // The same three answers for every kind of audience.
    expect(
      within(terms)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Limit', 'Unlimited', 'Off']);
    fireEvent.click(within(terms).getByLabelText('Limit'));
    fireEvent.click(
      within(editor).getByRole('button', { name: 'Add 3 entries' }),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      rule({
        series: 'claude',
        groups: [{ target: GROUP_ID, requests: 100 }],
        domains: [{ target: 'oca.msf.org', requests: 100 }],
        allow: [{ target: 'ana@msf.org', requests: 100 }],
      }),
    ]);
  });

  it('keeps text that is not a person, group or domain in the field and says why', () => {
    const onChange = renderTab();
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    const field = screen.getByRole('combobox', {
      name: 'People, groups or domains to add',
    });
    fireEvent.change(field, { target: { value: 'finance team' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not recognised: finance, team.',
    );
    expect(field).toHaveValue('finance, team');
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lists groups, domains and people together, each with the same control: cap, switch off, remove', () => {
    const rules = [
      rule({
        series: 'claude',
        defaultAccess: null,
        groups: [{ target: 'g1', requests: 100 }],
        domains: [{ target: 'oca.msf.org', requests: null }],
        allow: [{ target: 'ana@msf.org', requests: 5 }],
        deny: ['m@msf.org'],
      }),
    ];
    const onChange = renderTab(rules);
    fireEvent.click(cell('Claude, g1: Limited to 100 / day'));
    const list = screen.getByRole('list', {
      name: 'Groups, domains and people',
    });
    expect(
      within(list)
        .getAllByRole('radiogroup')
        .map((group) => group.getAttribute('aria-label')),
    ).toEqual([
      'Terms for g1',
      'Terms for oca.msf.org',
      'Terms for ana@msf.org',
      'Terms for m@msf.org',
    ]);
    // A blocked person reads as Off, like everything else that is off.
    expect(
      within(
        within(list).getByRole('radiogroup', { name: 'Terms for m@msf.org' }),
      ).getByLabelText('Off'),
    ).toBeChecked();

    // Switching a GROUP off moves it from the grants to the blocked groups.
    fireEvent.click(
      within(
        within(list).getByRole('radiogroup', { name: 'Terms for g1' }),
      ).getByLabelText('Off'),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      { ...rules[0], groups: [], denyGroups: ['g1'] },
    ]);
    // Removing a DOMAIN uses the same button a person has.
    fireEvent.click(
      within(list).getByRole('button', { name: 'Remove oca.msf.org' }),
    );
    expect(onChange).toHaveBeenLastCalledWith([{ ...rules[0], domains: [] }]);
  });

  it('a model shows its family terms as inherited, and can take its own', () => {
    const rules = [
      rule({
        series: 'claude',
        defaultAccess: false,
        groups: [{ target: 'g1', requests: 100 }],
        denyDomains: ['ext.org'],
      }),
    ];
    const onChange = renderTab(rules);
    expect(cell('Claude, g1: Limited to 100 / day')).toBeInTheDocument();
    expect(cell('Claude, ext.org: Unavailable')).toBeInTheDocument();
    expect(
      cell('Claude Sonnet 5, g1: Limited to 100 / day, inherited'),
    ).toBeInTheDocument();
    expect(
      cell('Claude Sonnet 5, ext.org: Unavailable, inherited'),
    ).toBeInTheDocument();

    fireEvent.click(
      cell('Claude Sonnet 5, g1: Limited to 100 / day, inherited'),
    );
    const editor = screen.getByRole('region', {
      name: 'Who can use Claude Sonnet 5',
    });
    // Opened from a column the model says nothing in: g1 waits in the field.
    expect(
      within(editor).getByRole('button', { name: 'Add 1 entry' }),
    ).toBeEnabled();
    expect(within(editor).getAllByText('from the family')).toHaveLength(2);
    fireEvent.click(
      within(editor).getByRole('button', {
        name: 'Change g1 for this model',
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      rules[0],
      rule({
        modelId: 'claude-sonnet-5',
        groups: [{ target: 'g1', requests: 100 }],
      }),
    ]);
  });

  it('gives a group the same access on several models in one step', async () => {
    const rules = [rule({ series: 'claude', defaultAccess: false })];
    const onChange = renderTab(rules);
    fireEvent.click(
      screen.getByRole('button', { name: 'Add access on several models' }),
    );
    const form = screen.getByRole('region', {
      name: 'Give the same access on several models',
    });
    const apply = within(form).getByRole('button', { name: 'Choose models' });
    expect(apply).toBeDisabled();
    const field = within(form).getByRole('combobox');
    fireEvent.change(field, { target: { value: 'oca.msf.org' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.click(
      within(form).getByRole('checkbox', { name: /^Claude whole/ }),
    );
    fireEvent.click(
      within(form).getByRole('checkbox', { name: 'Claude Sonnet 5' }),
    );
    fireEvent.click(
      within(form).getByRole('button', { name: 'Apply to 2 rows' }),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      rule({
        series: 'claude',
        defaultAccess: false,
        domains: [{ target: 'oca.msf.org', requests: null }],
      }),
      rule({
        modelId: 'claude-sonnet-5',
        domains: [{ target: 'oca.msf.org', requests: null }],
      }),
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole('region', {
          name: 'Give the same access on several models',
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it('counts named people, sums up who can use it, and flags a collision with Global defaults', () => {
    renderTab(
      [
        rule({
          series: 'claude',
          defaultAccess: false,
          groups: [{ target: 'g1', requests: null }],
          allow: [
            { target: 'a@msf.org', requests: 5 },
            { target: 'b@msf.org', requests: null },
          ],
          deny: ['m@msf.org'],
        }),
      ],
      'enforce',
      [
        {
          limitKey: 'model.allowed',
          series: 'claude',
          value: true,
          ceiling: false,
        },
      ],
    );
    expect(cell('Claude, Named people: 2 allowed, 1 off')).toBeInTheDocument();
    const row = screen
      .getByRole('rowheader', { name: /^Claude.*family: shared/ })
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('1 group, 2 people')).toBeInTheDocument();
    expect(
      within(row).getByText('Also in Global defaults'),
    ).toBeInTheDocument();
  });

  it('sums up an open model by who is shut out', () => {
    renderTab([
      rule({
        series: 'claude',
        defaultAccess: null,
        denyDomains: ['ext.org'],
        deny: ['m@msf.org'],
      }),
    ]);
    const row = screen
      .getByRole('rowheader', { name: /^Claude.*family: shared/ })
      .closest('tr') as HTMLElement;
    expect(
      within(row).getByText('Everyone except 1 domain, 1 person'),
    ).toBeInTheDocument();
  });

  it('opens the editor from the model name, with the keyboard in the add field, and Escape hands focus back', () => {
    renderTab();
    const name = screen.getByRole('button', {
      name: 'Claude edit who can use it',
    });
    fireEvent.click(name);
    const editor = screen.getByRole('region', { name: 'Who can use Claude' });
    expect(within(editor).getByRole('combobox')).toHaveFocus();
    fireEvent.keyDown(within(editor).getByRole('combobox'), { key: 'Escape' });
    expect(
      screen.queryByRole('region', { name: 'Who can use Claude' }),
    ).not.toBeInTheDocument();
    expect(name).toHaveFocus();
  });

  it('opened from Everyone else, focus starts on that control', () => {
    renderTab();
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    expect(screen.getByRole('radio', { name: 'Inherit' })).toHaveFocus();
  });

  it('after Add the field has focus again and the terms start afresh', () => {
    const rules: ModelAccessRule[] = [];
    const onChange = renderTab(rules);
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    const editor = screen.getByRole('region', { name: 'Who can use Claude' });
    const field = within(editor).getByRole('combobox');
    const terms = within(editor).getByRole('radiogroup', {
      name: 'What the people, groups and domains being added get',
    });
    fireEvent.change(field, { target: { value: 'oca.msf.org' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.click(within(terms).getByLabelText('Off'));
    fireEvent.click(
      within(editor).getByRole('button', { name: 'Add 1 entry' }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(field).toHaveFocus();
    // Off was for that entry only: the next one starts at Unlimited.
    expect(within(terms).getByLabelText('Unlimited')).toBeChecked();
  });

  it('says so before replacing the terms of someone already on the row', () => {
    renderTab([
      rule({
        series: 'claude',
        domains: [{ target: 'oca.msf.org', requests: 50 }],
      }),
    ]);
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    const editor = screen.getByRole('region', { name: 'Who can use Claude' });
    const field = within(editor).getByRole('combobox');
    fireEvent.change(field, { target: { value: 'oca.msf.org, new.org' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(
      within(editor).getByText(
        'Already on this row: oca.msf.org. Adding replaces what it gets.',
      ),
    ).toBeInTheDocument();
  });

  it('does not drop entries waiting in the field when the editor is closed', () => {
    const onChange = renderTab();
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    const editor = screen.getByRole('region', { name: 'Who can use Claude' });
    const field = within(editor).getByRole('combobox');
    fireEvent.change(field, { target: { value: 'oca.msf.org' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
    // Still open, and it says why.
    expect(within(editor).getByRole('alert')).toHaveTextContent(
      '1 entry in the field is not added yet.',
    );
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(
      within(editor).getByRole('button', { name: 'Add and close' }),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      rule({
        series: 'claude',
        domains: [{ target: 'oca.msf.org', requests: null }],
      }),
    ]);
    expect(
      screen.queryByRole('region', { name: 'Who can use Claude' }),
    ).not.toBeInTheDocument();
  });

  it('filters a long list of entries, and not a short one', () => {
    const people = Array.from({ length: 9 }, (_, n) => ({
      target: `p${n}@msf.org`,
      requests: null,
    }));
    renderTab([rule({ series: 'claude', allow: people })]);
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    const editor = screen.getByRole('region', { name: 'Who can use Claude' });
    const filter = within(editor).getByRole('searchbox', {
      name: 'Filter this list',
    });
    fireEvent.change(filter, { target: { value: 'p3@' } });
    expect(within(editor).getByText('Showing 1 of 9')).toBeInTheDocument();
    expect(
      within(editor).getAllByRole('radiogroup', { name: /^Terms for/ }),
    ).toHaveLength(1);
    // The boundary: eight entries need no filter.
    fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
  });

  it('shows no filter at eight entries', () => {
    const people = Array.from({ length: 8 }, (_, n) => ({
      target: `p${n}@msf.org`,
      requests: null,
    }));
    renderTab([rule({ series: 'claude', allow: people })]);
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('takes an audience off several models in one step, and says what it did', () => {
    const grant = { domains: [{ target: 'oca.msf.org', requests: null }] };
    const rules = [
      rule({ series: 'claude', defaultAccess: false, ...grant }),
      rule({ modelId: 'claude-sonnet-5', ...grant }),
    ];
    const onChange = renderTab(rules);
    fireEvent.click(
      screen.getByRole('button', { name: 'Add access on several models' }),
    );
    const form = screen.getByRole('region', {
      name: 'Give the same access on several models',
    });
    fireEvent.click(
      within(form).getByRole('radio', { name: 'Remove from these rows' }),
    );
    // Removing has no terms to choose.
    expect(within(form).queryByRole('radiogroup')).not.toBeInTheDocument();
    const field = within(form).getByRole('combobox');
    fireEvent.change(field, { target: { value: 'oca.msf.org' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.change(
      within(form).getByRole('searchbox', { name: 'Filter models' }),
      { target: { value: 'claude' } },
    );
    fireEvent.click(
      within(form).getByRole('button', { name: 'Select all shown' }),
    );
    const apply = within(form).getByRole('button', {
      name: /^Remove from \d+ rows$/,
    });
    fireEvent.click(apply);
    // Only the family default is left; the model rule said nothing else.
    expect(onChange).toHaveBeenLastCalledWith([
      rule({ series: 'claude', defaultAccess: false }),
    ]);
    expect(screen.getByRole('status')).toHaveTextContent(
      /^1 entry removed from \d+ rows\. Not saved yet\.$/,
    );
  });
});
