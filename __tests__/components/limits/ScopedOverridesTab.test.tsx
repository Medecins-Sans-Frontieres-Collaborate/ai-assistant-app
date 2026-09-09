import { render, screen } from '@testing-library/react';
import React from 'react';

import type {
  ScopedDelegationView,
  ScopedLimitsView,
} from '@/client/hooks/settings/useLimitsAdmin';

import { JurisdictionPredicate } from '@/lib/services/limits/types';

import { ScopedOverridesTab } from '@/components/Limits/ScopedOverridesTab';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

/**
 * Contract (design §6c): the note over the effective-limits preview explains
 * why a preview BY MAIL cannot work, and must agree with the server's gate
 * (`canPreviewMail` over the caller's ENABLED delegations):
 *   - any enabled delegation anchored on a domain/user → no note;
 *   - none anchored, some enabled group/attribute predicate → "groups only";
 *   - none anchored and nothing opaque (empty jurisdiction, or every
 *     delegation disabled) → "matches nobody" — NOT "defined by groups".
 * The scoped GET returns DISABLED delegations too (inert, visible to their
 * author); they must not count, or the note promises a preview the server
 * refuses. The preview itself is told it runs in scoped mode.
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// Stubs: the card and the preview have their own tests; this one pins what
// the tab DERIVES and passes down.
vi.mock('@/components/Limits/ScopedOverrideCard', () => ({
  ScopedOverrideCard: () => <div data-testid="card" />,
}));
vi.mock('@/components/Limits/EffectiveLimitsPreview', () => ({
  EffectiveLimitsPreview: (props: { scoped?: boolean; scopeNote?: string }) => (
    <div
      data-testid="preview"
      data-scoped={props.scoped ? 'true' : 'false'}
      data-note={props.scopeNote ?? ''}
    />
  ),
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

const DOMAIN_OCP: JurisdictionPredicate = {
  scope: 'domain',
  targets: ['ocp.msf.org'],
};
const GROUP_G1: JurisdictionPredicate = {
  scope: 'group',
  targets: ['11111111-2222-3333-4444-555555555555'],
};

function renderTab(delegations: ScopedDelegationView[]) {
  const view: ScopedLimitsView = {
    isGlobalAdmin: false,
    mode: 'enforce',
    timezone: 'UTC',
    policyUnavailable: false,
    delegations,
    overrides: [],
  };
  render(<ScopedOverridesTab view={view} onRefetch={vi.fn()} />);
  return screen.getByTestId('preview');
}

describe('ScopedOverridesTab — preview scope note (design §6c)', () => {
  it('runs the preview in scoped mode with no note when a delegation is mail-anchored', () => {
    const preview = renderTab([delegation([DOMAIN_OCP])]);
    expect(preview).toHaveAttribute('data-scoped', 'true');
    expect(preview).toHaveAttribute('data-note', '');
  });

  it("says 'groups only' for an enabled group-only delegation", () => {
    const preview = renderTab([delegation([GROUP_G1])]);
    expect(preview).toHaveAttribute('data-note', 'previewGroupOnlyScope');
  });

  it("says 'matches nobody', not 'groups only', when the only delegation is empty", () => {
    const preview = renderTab([delegation([])]);
    expect(preview).toHaveAttribute('data-note', 'previewScopeMatchesNobody');
  });

  it('ignores a DISABLED anchored delegation: enabled group-only still gets the note', () => {
    const preview = renderTab([
      delegation([DOMAIN_OCP], { enabled: false }),
      delegation([GROUP_G1]),
    ]);
    expect(preview).toHaveAttribute('data-note', 'previewGroupOnlyScope');
  });

  it("says 'matches nobody' when every delegation is disabled", () => {
    const preview = renderTab([delegation([DOMAIN_OCP], { enabled: false })]);
    expect(preview).toHaveAttribute('data-note', 'previewScopeMatchesNobody');
  });
});
