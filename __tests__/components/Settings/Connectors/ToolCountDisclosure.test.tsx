import { fireEvent, render, screen, within } from '@testing-library/react';

import { ToolCountDisclosure } from '@/components/Settings/Connectors/ToolCountDisclosure';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it } from 'vitest';

const TOOLS = [
  { name: 'get_me', description: 'Get the authenticated user' },
  { name: 'get_teams', description: 'List teams' },
];

function policyRow(toolName: string): HTMLElement {
  const row = screen.getByText(toolName).closest('li');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('ToolCountDisclosure', () => {
  beforeEach(() => {
    useSettingsStore.setState({ toolApprovalRules: [] });
  });

  it('renders nothing while the server advertises no tools', () => {
    const { container } = render(
      <ToolCountDisclosure serverLabel="GitHub" tools={[]} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('expands the count into a per-tool policy list', () => {
    render(<ToolCountDisclosure serverLabel="GitHub" tools={TOOLS} />);

    expect(screen.queryByText('get_me')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('2 tools available'));

    expect(screen.getByText('get_me')).toBeInTheDocument();
    expect(screen.getByText('get_teams')).toBeInTheDocument();
  });

  it('defaults every tool to Ask and writes a scoped rule on Allow/Block', () => {
    render(<ToolCountDisclosure serverLabel="GitHub" tools={TOOLS} />);
    fireEvent.click(screen.getByText('2 tools available'));

    expect(
      within(policyRow('get_me')).getByRole('button', { pressed: true }),
    ).toHaveTextContent('Ask');

    fireEvent.click(within(policyRow('get_me')).getByText('Allow'));
    fireEvent.click(within(policyRow('get_teams')).getByText('Block'));

    expect(useSettingsStore.getState().toolApprovalRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'get_me',
          serverLabel: 'GitHub',
          action: 'approve',
        }),
        expect.objectContaining({
          toolName: 'get_teams',
          serverLabel: 'GitHub',
          action: 'reject',
        }),
      ]),
    );
    expect(
      within(policyRow('get_me')).getByRole('button', { pressed: true }),
    ).toHaveTextContent('Allow');
  });

  it('Ask clears the rule — including an unscoped one that applied here', () => {
    // An unscoped block from the settings form would otherwise silently
    // keep winning after the user explicitly set "Ask" on this server.
    useSettingsStore
      .getState()
      .addToolApprovalRule({ toolName: 'get_me', action: 'reject' });
    render(<ToolCountDisclosure serverLabel="GitHub" tools={TOOLS} />);
    fireEvent.click(screen.getByText('2 tools available'));

    // The unscoped rule reads as Block for this server.
    expect(
      within(policyRow('get_me')).getByRole('button', { pressed: true }),
    ).toHaveTextContent('Block');

    fireEvent.click(within(policyRow('get_me')).getByText('Ask'));

    expect(useSettingsStore.getState().toolApprovalRules).toHaveLength(0);
    expect(
      within(policyRow('get_me')).getByRole('button', { pressed: true }),
    ).toHaveTextContent('Ask');
  });

  it('reflects rules created elsewhere (consent card, settings form)', () => {
    useSettingsStore.getState().addToolApprovalRule({
      toolName: 'get_teams',
      serverLabel: 'GitHub',
      action: 'approve',
    });
    render(<ToolCountDisclosure serverLabel="GitHub" tools={TOOLS} />);
    fireEvent.click(screen.getByText('2 tools available'));

    expect(
      within(policyRow('get_teams')).getByRole('button', { pressed: true }),
    ).toHaveTextContent('Allow');
  });
});
