import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { AccessSummary } from '@/components/AgentAccess/AccessSummary';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/useGroupNames', () => ({
  useGroupNames: () => ({ 'known-group': 'Logistics team' }),
}));

describe('AccessSummary', () => {
  it('shows implicit and explicit everyone without listing stale targets', () => {
    const { rerender } = render(<AccessSummary />);
    expect(screen.getByText('All eligible users')).toHaveAttribute(
      'title',
      'App access rules only. Source permissions still apply.',
    );
    expect(screen.getByText('All eligible users')).not.toHaveClass(
      'bg-green-100',
    );
    rerender(
      <AccessSummary
        access={{
          type: 'everyone',
          allowUsers: ['stale@example.org'],
          allowDomains: [],
          allowGroups: [],
        }}
      />,
    );
    expect(screen.queryByText('stale@example.org')).not.toBeInTheDocument();
  });

  it('shows domains, users and resolved group names as distinct audiences', () => {
    render(
      <AccessSummary
        access={{
          type: 'restricted',
          allowDomains: ['msf.org'],
          allowUsers: ['person@msf.org'],
          allowGroups: ['known-group'],
        }}
      />,
    );
    expect(screen.getByText('msf.org')).toBeInTheDocument();
    expect(screen.getByText('person@msf.org')).toBeInTheDocument();
    expect(screen.getByText('Logistics team')).toHaveAttribute(
      'title',
      'known-group',
    );
    expect(screen.queryByText('Restricted')).not.toBeInTheDocument();
  });

  it('does not confuse an empty restriction with everyone', () => {
    render(
      <AccessSummary
        access={{
          type: 'restricted',
          allowDomains: [],
          allowUsers: [],
          allowGroups: [],
        }}
      />,
    );
    expect(screen.getByText('No allowed audience')).toBeInTheDocument();
    expect(screen.queryByText('All eligible users')).not.toBeInTheDocument();
  });

  it('brackets the preview boundary and reveals every full unresolved group ID', () => {
    const ids = [
      '12345678-one',
      '12345678-two',
      '12345678-three',
      '12345678-four',
    ];
    const { rerender } = render(
      <AccessSummary
        access={{
          type: 'restricted',
          allowDomains: [],
          allowUsers: [],
          allowGroups: ids.slice(0, 3),
        }}
      />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(
      <AccessSummary
        access={{
          type: 'restricted',
          allowDomains: [],
          allowUsers: [],
          allowGroups: ids,
        }}
      />,
    );
    expect(screen.getByText('+1')).toBeInTheDocument();
    const expand = screen.getByRole('button');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);
    ids.forEach((id) => expect(screen.getByText(id)).toBeInTheDocument());
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(expand);
    expect(screen.queryByText(ids[3])).not.toBeInTheDocument();
  });
});
