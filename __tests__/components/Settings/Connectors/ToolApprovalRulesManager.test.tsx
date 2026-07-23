import { fireEvent, render, screen } from '@testing-library/react';

import { ToolApprovalRulesManager } from '@/components/Settings/Connectors/ToolApprovalRulesManager';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it } from 'vitest';

describe('ToolApprovalRulesManager', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      toolApprovalRules: [],
      mcpServers: [
        {
          id: 's1',
          name: 'GitHub',
          enabled: true,
          authMode: 'oauth',
        },
      ] as unknown as ReturnType<
        typeof useSettingsStore.getState
      >['mcpServers'],
    });
  });

  it('is collapsed by default and expands from the heading', () => {
    render(<ToolApprovalRulesManager />);

    expect(screen.queryByPlaceholderText(/Tool name/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Tool approvals'));

    expect(screen.getByPlaceholderText(/Tool name/)).toBeInTheDocument();
  });

  it('adds a rule for a tool the user has never been prompted for', () => {
    render(<ToolApprovalRulesManager />);
    fireEvent.click(screen.getByText('Tool approvals'));

    fireEvent.change(screen.getByLabelText('Tool name'), {
      target: { value: 'delete_repository' },
    });
    fireEvent.change(screen.getByLabelText('Connector scope'), {
      target: { value: 'GitHub' },
    });
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'reject' },
    });
    fireEvent.click(screen.getByText('Add rule'));

    expect(useSettingsStore.getState().toolApprovalRules).toEqual([
      expect.objectContaining({
        toolName: 'delete_repository',
        serverLabel: 'GitHub',
        action: 'reject',
      }),
    ]);
    // The new rule renders in the list.
    expect(screen.getByText('delete_repository')).toBeInTheDocument();
  });

  it('starts expanded when rules already exist, and deletes from the list', () => {
    useSettingsStore
      .getState()
      .addToolApprovalRule({ toolName: 'create_issue', action: 'approve' });
    render(<ToolApprovalRulesManager />);

    expect(screen.getByText('create_issue')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove rule for create_issue'));

    expect(useSettingsStore.getState().toolApprovalRules).toHaveLength(0);
  });
});
