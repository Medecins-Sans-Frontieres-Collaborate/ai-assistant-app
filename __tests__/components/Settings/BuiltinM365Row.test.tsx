// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';

import { BuiltinM365Row } from '@/components/Settings/Connectors/BuiltinM365Row';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it } from 'vitest';

// jsdom serves localhost, so the fail-closed flag's localhost hatch is on.

beforeEach(() => {
  useSettingsStore.setState({
    m365Connected: true,
    m365ToolsUserEnabled: true,
    toolApprovalRules: [],
  });
});

describe('BuiltinM365Row', () => {
  it('renders as a connector row with the global toggle wired to settings', () => {
    render(<BuiltinM365Row />);
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
    const toggle = screen.getByRole('checkbox');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().m365ToolsUserEnabled).toBe(false);
  });

  it('lists catalog tools with locked chips on alwaysConfirm writes', () => {
    render(<BuiltinM365Row />);
    // Open the tool disclosure.
    fireEvent.click(screen.getByText(/toolCount|tools/i));
    // A read tool gets the Ask/Allow/Block group; a write tool is locked.
    expect(screen.getByText('calendar_list_events')).toBeInTheDocument();
    expect(screen.getByText('calendar_create_event')).toBeInTheDocument();
    const lockedChips = screen.getAllByText('alwaysAsks');
    // Exactly the alwaysConfirm set: calendar_create_event, tasks_create,
    // and the four mail draft tools.
    expect(lockedChips.length).toBe(6);
  });

  it('shows a connect hint when M365 is not connected', () => {
    useSettingsStore.setState({ m365Connected: false });
    render(<BuiltinM365Row />);
    expect(screen.getByText('connectFirstHint')).toBeInTheDocument();
  });
});
