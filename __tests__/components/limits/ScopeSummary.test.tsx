import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { ScopedDelegationView } from '@/client/hooks/settings/useLimitsAdmin';

import { JurisdictionPredicate } from '@/lib/services/limits/types';

import { ScopeSummary } from '@/components/Limits/ScopeSummary';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

/**
 * Contract (design §2 "Empty = matches nobody", §6b/§8): an UNANCHORED
 * jurisdiction is one of two things and the summary must say which —
 * group/attribute-only ("Groups only": opaque to a mail preview, inherits the
 * group cache's failure posture) or no targets at all ("Matches nobody": the
 * disabled-in-practice delegation a global admin emptied). Telling the second
 * admin their scope "is defined by groups or attributes" is a false statement.
 * DelegationEditor already splits the two; this pins the scoped surface.
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

let counter = 0;
function delegation(
  jurisdiction: JurisdictionPredicate[],
  extra: Partial<ScopedDelegationView> = {},
): ScopedDelegationView {
  counter += 1;
  return {
    id: `del-${counter.toString(16).padStart(12, '0')}`,
    label: `D${counter}`,
    enabled: true,
    jurisdiction,
    maxOverrides: 25,
    overrideCount: 0,
    warnings: [],
    ...extra,
  };
}

const GROUP_G1: JurisdictionPredicate = {
  scope: 'group',
  targets: ['11111111-2222-3333-4444-555555555555'],
};

describe('ScopeSummary', () => {
  it("labels an EMPTY jurisdiction 'matches nobody', never 'groups only'", () => {
    render(<ScopeSummary delegations={[delegation([])]} />);
    expect(screen.getByText('yourScopeMatchesNobodyChip')).toBeInTheDocument();
    expect(
      screen.queryByText('yourScopeGroupOnlyChip'),
    ).not.toBeInTheDocument();
    // The collapsed one-liner agrees.
    expect(screen.getByText('jurisdictionMatchesNobody')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'yourScopeShowAll' }));
    expect(screen.getByText('yourScopeMatchesNobodyNote')).toBeInTheDocument();
    expect(
      screen.queryByText('yourScopeGroupOnlyNote'),
    ).not.toBeInTheDocument();
  });

  it('treats a predicate with no targets as empty (design: judged on targets)', () => {
    render(
      <ScopeSummary
        delegations={[delegation([{ scope: 'group', targets: [] }])]}
      />,
    );
    expect(screen.getByText('yourScopeMatchesNobodyChip')).toBeInTheDocument();
    expect(
      screen.queryByText('yourScopeGroupOnlyChip'),
    ).not.toBeInTheDocument();
  });

  it("labels a group-only jurisdiction 'groups only' with its note", () => {
    render(<ScopeSummary delegations={[delegation([GROUP_G1])]} />);
    expect(screen.getByText('yourScopeGroupOnlyChip')).toBeInTheDocument();
    expect(
      screen.queryByText('yourScopeMatchesNobodyChip'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'yourScopeShowAll' }));
    expect(screen.getByText('yourScopeGroupOnlyNote')).toBeInTheDocument();
    expect(
      screen.queryByText('yourScopeMatchesNobodyNote'),
    ).not.toBeInTheDocument();
  });

  it('shows neither chip for a mail-anchored jurisdiction, even a mixed one', () => {
    render(
      <ScopeSummary
        delegations={[
          delegation([{ scope: 'domain', targets: ['ocp.msf.org'] }, GROUP_G1]),
        ]}
      />,
    );
    expect(
      screen.queryByText('yourScopeGroupOnlyChip'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('yourScopeMatchesNobodyChip'),
    ).not.toBeInTheDocument();
  });
});
