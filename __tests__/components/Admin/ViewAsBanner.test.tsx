/**
 * ViewAsBanner summarises the ACTIVE view-as overrides from the session. A
 * demoted admin previewing a scoped-limits persona (adminRole 'local' +
 * limitDelegationIds) must see the delegation count, not just "local admin"
 * — otherwise two very different personas read identically in the banner.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';

import { ViewAsBanner } from '@/components/Admin/ViewAs/ViewAsBanner';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({
  overrides: {} as Record<string, unknown>,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values && 'count' in values ? `${key}:${values.count}` : key,
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: { viewAs: { overrides: sessionState.overrides, actual: {} } },
    },
    status: 'authenticated',
  }),
}));
vi.mock('@/client/hooks/settings/useViewAs', () => ({
  useViewAs: () => ({ clear: { mutate: vi.fn(), isPending: false } }),
}));
vi.mock('@/lib/navigation', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('ViewAsBanner', () => {
  it('names the limits delegations of a demoted scoped-limits persona', () => {
    sessionState.overrides = {
      adminRole: 'local',
      limitDelegationIds: ['del-0123456789ab', 'del-0123456789ac'],
    };
    render(<ViewAsBanner />);
    expect(
      screen.getByText('label: role.local · limitDelegations:2'),
    ).toBeInTheDocument();
  });

  it('omits the delegations part when none are set', () => {
    sessionState.overrides = { adminRole: 'local', groupIds: ['g1'] };
    render(<ViewAsBanner />);
    expect(
      screen.getByText('label: role.local · groups:1'),
    ).toBeInTheDocument();
  });
});
