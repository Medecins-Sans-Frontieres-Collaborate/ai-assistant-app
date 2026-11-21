import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
vi.mock('@/client/services/m365/m365Client', () => ({
  lookupEntraGroups: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/components/AgentAccess/GroupSearchPicker', () => ({
  GroupSearchPicker: ({
    onChange,
  }: {
    onChange: (values: string[]) => void;
  }) => (
    <button type="button" onClick={() => onChange(['g-research'])}>
      add-group
    </button>
  ),
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

  it('edits a family default from its cell with the shared four-way control', () => {
    const onChange = renderTab();
    fireEvent.click(cell('Claude, Everyone else: Unavailable, inherited'));
    const control = screen.getByRole('radiogroup');
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

  it('a model shows its family default as inherited; a new audience column grants per cell', () => {
    const rules = [rule({ series: 'claude', defaultAccess: 50 })];
    const onChange = renderTab(rules);
    expect(
      cell('Claude, Everyone else: Limited to 50 / day'),
    ).toBeInTheDocument();
    // The model has no default of its own: same answer, marked inherited.
    expect(
      cell('Claude Sonnet 5, Everyone else: Limited to 50 / day, inherited'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Add an audience column' }),
    );
    fireEvent.click(screen.getByText('add-group'));
    expect(
      screen.getByRole('columnheader', { name: /g-research/ }),
    ).toBeInTheDocument();

    fireEvent.click(cell('Claude Sonnet 5, g-research: no terms of its own'));
    const control = screen.getByRole('radiogroup');
    // A grant cannot be Off: blocking is the block list's job.
    expect(
      within(control)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Inherit', 'Limit', 'Unlimited']);
    fireEvent.click(within(control).getByLabelText('Unlimited'));
    expect(onChange).toHaveBeenLastCalledWith([
      rules[0],
      rule({
        modelId: 'claude-sonnet-5',
        groups: [{ target: 'g-research', requests: null }],
      }),
    ]);
  });

  it('a model inherits its family grant, dashed, in that audience column', () => {
    renderTab([
      rule({
        series: 'claude',
        defaultAccess: false,
        groups: [{ target: 'g1', requests: 100 }],
      }),
    ]);
    expect(cell('Claude, g1: Limited to 100 / day')).toBeInTheDocument();
    expect(
      cell('Claude Sonnet 5, g1: Limited to 100 / day, inherited'),
    ).toBeInTheDocument();
  });

  it('counts the people lists, sums up who can use it, and flags a collision with Global defaults', () => {
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
    expect(cell('Claude, Allowed people: 2')).toBeInTheDocument();
    expect(cell('Claude, Blocked people: 1')).toBeInTheDocument();
    const row = screen
      .getByRole('rowheader', { name: /^Claude.*family: shared/ })
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('1 group, 2 people')).toBeInTheDocument();
    expect(
      within(row).getByText('Also in Global defaults'),
    ).toBeInTheDocument();

    // The block list opens as a list of people, not a number.
    fireEvent.click(cell('Claude, Blocked people: 1'));
    expect(screen.getByText('m@msf.org')).toBeInTheDocument();
  });
});
