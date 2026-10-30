import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import type { ModelAccessRule } from '@/lib/services/limits/types';

import { ModelAccessTab } from '@/components/Limits/ModelAccessTab';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useLocale: () => 'en',
}));
vi.mock('launchdarkly-react-client-sdk', () => ({ useFlags: () => ({}) }));
vi.mock('@/client/hooks/useM365PeopleSuggest', () => ({
  useM365PeopleSuggest: () => undefined,
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

function renderTab(
  rules: ModelAccessRule[] = [],
  mode: 'observe' | 'enforce' = 'enforce',
) {
  const onChange = vi.fn();
  render(
    <ModelAccessTab
      rules={rules}
      defaults={[]}
      onChange={onChange}
      mode={mode}
    />,
  );
  return onChange;
}

/** The card for one node, located by its visible label. */
function card(label: string): HTMLElement {
  const node = screen
    .getByText(label)
    .closest('div.rounded-lg, div[class*="rounded"]');
  if (!node) throw new Error(`no card for ${label}`);
  return node as HTMLElement;
}

beforeEach(() => {
  useSettingsStore.setState({ models: [] });
});

describe('ModelAccessTab', () => {
  it('lists the Claude family from the static catalog as unavailable by default, inherited', () => {
    renderTab();
    const claude = screen.getByText('Claude');
    const chip = within(claude.parentElement as HTMLElement).getByTestId(
      'model-access-state',
    );
    expect(chip).toHaveTextContent('modelAccess.state.unavailable');
    expect(chip).toHaveTextContent('modelAccess.inheritedChip');
    expect(screen.getByText(/modelAccess\.externalNote/)).toHaveTextContent(
      'Claude',
    );
  });

  it('shows the observe-mode note only in observe mode', () => {
    renderTab([], 'observe');
    expect(screen.getByText('modelAccess.observeNote')).toBeInTheDocument();
  });

  it('setting a family default to Unlimited emits a rule for that series', () => {
    const onChange = renderTab();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'modelAccess.editNode:{"label":"Claude"}',
      }),
    );
    const editor = card('Claude');
    const [defaultSelect] = within(editor).getAllByRole('combobox');
    fireEvent.change(defaultSelect, { target: { value: 'unlimited' } });
    expect(onChange).toHaveBeenCalledWith([
      {
        series: 'claude',
        defaultAccess: null,
        groups: [],
        domains: [],
        allow: [],
        deny: [],
      },
    ]);
  });

  it('a model inherits the family rule and reports it; adding a group grant emits an unlimited grant', () => {
    const rules: ModelAccessRule[] = [
      {
        series: 'claude',
        defaultAccess: 50,
        groups: [],
        domains: [],
        allow: [],
        deny: [],
      },
    ];
    const onChange = renderTab(rules);
    // Family chip now shows the limit, not inherited.
    const familyChip = within(
      screen.getByText('Claude').parentElement as HTMLElement,
    ).getByTestId('model-access-state');
    expect(familyChip).toHaveTextContent(
      'modelAccess.state.limited:{"requests":50}',
    );
    expect(familyChip).not.toHaveTextContent('inheritedChip');

    // A member inherits it.
    const sonnet = screen.getByText('Claude Sonnet 5');
    const memberChip = within(sonnet.parentElement as HTMLElement).getByTestId(
      'model-access-state',
    );
    expect(memberChip).toHaveTextContent(
      'modelAccess.state.limited:{"requests":50}',
    );
    expect(memberChip).toHaveTextContent('modelAccess.inheritedChip');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'modelAccess.editNode:{"label":"Claude Sonnet 5"}',
      }),
    );
    fireEvent.click(screen.getByText('add-group'));
    expect(onChange).toHaveBeenCalledWith([
      rules[0],
      {
        modelId: 'claude-sonnet-5',
        groups: [{ target: 'g-research', requests: null }],
        domains: [],
        allow: [],
        deny: [],
      },
    ]);
  });

  it('shows list counts in the header and the collision chip when Global defaults also set the cell', () => {
    const rules: ModelAccessRule[] = [
      {
        series: 'claude',
        defaultAccess: false,
        groups: [{ target: 'g1', requests: null }],
        domains: [],
        allow: [
          { target: 'a@msf.org', requests: 5 },
          { target: 'b@msf.org', requests: null },
        ],
        deny: ['m@msf.org'],
      },
    ];
    const onChange = vi.fn();
    render(
      <ModelAccessTab
        rules={rules}
        defaults={[
          {
            limitKey: 'model.allowed',
            series: 'claude',
            value: true,
            ceiling: false,
          },
        ]}
        onChange={onChange}
        mode="enforce"
      />,
    );
    const header = screen.getByText('Claude').parentElement as HTMLElement;
    expect(header).toHaveTextContent('modelAccess.groupsCount:{"count":1}');
    expect(header).toHaveTextContent('modelAccess.allowCount:{"count":2}');
    expect(header).toHaveTextContent('modelAccess.denyCount:{"count":1}');
    expect(
      within(header).getByText('modelAccess.collisionChip'),
    ).toBeInTheDocument();
  });
});
