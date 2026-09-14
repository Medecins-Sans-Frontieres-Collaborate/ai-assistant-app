import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import type {
  ScopedDelegationView,
  ScopedLimitsView,
} from '@/client/hooks/settings/useLimitsAdmin';
import { ScopedLimitsError } from '@/client/hooks/settings/useLimitsAdmin';

import { LimitOverride } from '@/lib/services/limits/types';

import { ScopedOverridesTab } from '@/components/Limits/ScopedOverridesTab';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A NEVER-SAVED scoped draft lives only in the tab's `pendingNew` list. The
 * card retires that copy through `onSettled` once the server has the record;
 * a refused save must go through `onStale` instead, or a 409 after the CAS
 * rounds (and nothing else — the admin did nothing wrong) silently discards
 * the targets and entries they typed. Pins that split.
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/Limits/EffectiveLimitsPreview', () => ({
  EffectiveLimitsPreview: () => <div data-testid="preview" />,
}));
// The real editor needs chip typing to dirty a draft; a stub exposes one
// button that sets a target and a label, which is all the card looks at.
vi.mock('@/components/Limits/OverrideEditor', () => ({
  OverrideEditor: (props: {
    override: LimitOverride;
    onChange: (next: LimitOverride) => void;
  }) => (
    <div data-testid="editor">
      <button
        type="button"
        onClick={() =>
          props.onChange({
            ...props.override,
            label: 'x',
            targets: ['alice@ocp.msf.org'],
          })
        }
      >
        dirty
      </button>
    </div>
  ),
}));

const mutateAsync = vi.fn();
vi.mock('@/client/hooks/settings/useLimitsAdmin', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/client/hooks/settings/useLimitsAdmin')
    >();
  return {
    ...actual,
    useSaveScopedOverride: () => ({ mutateAsync, isPending: false }),
    useDeleteScopedOverride: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  };
});

const delegation: ScopedDelegationView = {
  id: 'del-000000000001',
  label: 'OCP',
  enabled: true,
  jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
  maxOverrides: 25,
  overrideCount: 0,
  warnings: [],
};

function renderTab() {
  const onRefetch = vi.fn();
  const view: ScopedLimitsView = {
    isGlobalAdmin: false,
    mode: 'enforce',
    timezone: 'UTC',
    policyUnavailable: false,
    delegations: [delegation],
    overrides: [],
  };
  render(<ScopedOverridesTab view={view} onRefetch={onRefetch} />);
  return onRefetch;
}

async function addDirtyDraftAndSave() {
  fireEvent.click(screen.getByText('addOverride'));
  expect(screen.getByTestId('editor')).toBeInTheDocument();
  fireEvent.click(screen.getByText('dirty'));
  fireEvent.click(screen.getByText('save'));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
}

describe('ScopedOverridesTab — a refused save keeps a never-saved draft', () => {
  beforeEach(() => mutateAsync.mockReset());

  it('keeps the draft on a 409 conflict and only refetches the surrounding data', async () => {
    mutateAsync.mockRejectedValueOnce(
      new ScopedLimitsError({
        status: 409,
        code: 'LIMITS_CONFLICT',
        message: 'conflict',
      }),
    );
    const onRefetch = renderTab();
    await addDirtyDraftAndSave();
    await waitFor(() => expect(onRefetch).toHaveBeenCalled());
    expect(screen.getByTestId('editor')).toBeInTheDocument();
  });

  it('keeps the draft on a 400 out-of-scope refusal (no refetch needed)', async () => {
    mutateAsync.mockRejectedValueOnce(
      new ScopedLimitsError({
        status: 400,
        code: 'LIMITS_OUT_OF_SCOPE',
        message: 'x',
        outOfScope: ['alice@ocp.msf.org'],
      }),
    );
    const onRefetch = renderTab();
    await addDirtyDraftAndSave();
    expect(screen.getByTestId('editor')).toBeInTheDocument();
    expect(onRefetch).not.toHaveBeenCalled();
  });

  it('retires the pending copy only once the save succeeded', async () => {
    mutateAsync.mockResolvedValueOnce({ override: {}, verdicts: [] });
    const onRefetch = renderTab();
    await addDirtyDraftAndSave();
    await waitFor(() =>
      expect(screen.queryByTestId('editor')).not.toBeInTheDocument(),
    );
    expect(onRefetch).toHaveBeenCalled();
  });
});
