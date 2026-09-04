import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ViewAsPanel } from '@/components/Admin/ViewAs/ViewAsPanel';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/AgentAccess/AgentKeyPicker', () => ({
  AgentKeyPicker: ({ id }: { id?: string }) => (
    <input id={id} data-testid="agent-key-picker" />
  ),
}));

const applyMutateAsync = vi.fn();
const viewAsState = vi.hoisted(() => ({
  data: {
    active: null as null | {
      overrides: Record<string, unknown>;
      actual: Record<string, unknown>;
    },
    actual: { region: 'EU', mail: 'admin@example.com' },
  },
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
vi.mock('@/client/hooks/settings/useViewAs', () => ({
  useViewAs: () => ({
    query: viewAsState,
    apply: { mutateAsync: applyMutateAsync, isPending: false },
    clear: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

describe('ViewAsPanel — limits delegations', () => {
  beforeEach(() => {
    applyMutateAsync.mockReset();
    viewAsState.data = {
      active: null,
      actual: { region: 'EU', mail: 'admin@example.com' },
    };
  });

  it('shows the delegation ids field only while the role is "local"', () => {
    render(<ViewAsPanel offices={[]} />);
    expect(
      screen.queryByLabelText('role.limitDelegationsLabel'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('role.local'));
    expect(
      screen.getByLabelText('role.limitDelegationsLabel'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('role.none'));
    expect(
      screen.queryByLabelText('role.limitDelegationsLabel'),
    ).not.toBeInTheDocument();
  });

  it('applies the ids under "local", split on newlines/commas and deduped', async () => {
    render(<ViewAsPanel offices={[]} />);
    fireEvent.click(screen.getByLabelText('role.local'));
    fireEvent.change(screen.getByLabelText('role.limitDelegationsLabel'), {
      target: {
        value: 'del-0123456789ab\n del-abcdef012345 , del-0123456789ab',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));

    expect(applyMutateAsync).toHaveBeenCalledWith({
      adminRole: 'local',
      limitDelegationIds: ['del-0123456789ab', 'del-abcdef012345'],
    });
  });

  it('seeds the field from an active view-as session', () => {
    viewAsState.data = {
      active: {
        overrides: {
          adminRole: 'local',
          limitDelegationIds: ['del-0123456789ab'],
        },
        actual: {},
      },
      actual: { region: 'EU', mail: 'admin@example.com' },
    };
    render(<ViewAsPanel offices={[]} />);
    expect(screen.getByLabelText('role.limitDelegationsLabel')).toHaveValue(
      'del-0123456789ab',
    );
  });
});
