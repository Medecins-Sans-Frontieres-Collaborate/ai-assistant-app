import { fireEvent, render, screen } from '@testing-library/react';

import { WorkflowPolicyPanel } from '@/components/Admin/Workflows/WorkflowPolicyPanel';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mutateAsync = vi.hoisted(() => vi.fn());
const queryData = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/client/hooks/settings/useWorkflowPolicyAdmin', () => ({
  WorkflowPolicyConflict: class extends Error {},
  useWorkflowPolicyAdmin: () => ({
    query: {
      data: queryData.current,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    },
    save: { mutateAsync, isPending: false },
  }),
}));

const FEATURE_LABEL = /features\.translation-preserve-formatting\.label/;
const TRANSLATION_LABEL = /types\.translation\.label/;

const savedPolicy = (features?: Record<string, { enabled: boolean }>) => ({
  policy: {
    version: 1,
    workflows: {},
    ...(features ? { features } : {}),
    updatedBy: 'admin@example.com',
    updatedAt: '2026-11-18T00:00:00.000Z',
  },
  etag: '"e1"',
  policyUnavailable: false,
});

describe('WorkflowPolicyPanel features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsync.mockResolvedValue({ etag: '"e2"' });
  });

  it('lists the feature under its workflow, on by default', () => {
    queryData.current = { policy: null, etag: null, policyUnavailable: false };
    render(<WorkflowPolicyPanel />);
    const feature = screen.getByLabelText(FEATURE_LABEL);
    expect(feature).toBeChecked();
    expect(feature).toBeEnabled();
    expect(
      screen.getByLabelText(TRANSLATION_LABEL).closest('li'),
    ).toContainElement(feature);
  });

  it('shows a saved off switch and saves the change with the workflows', async () => {
    queryData.current = savedPolicy({
      'translation-preserve-formatting': { enabled: false },
    });
    render(<WorkflowPolicyPanel />);
    const feature = screen.getByLabelText(FEATURE_LABEL);
    expect(feature).not.toBeChecked();

    fireEvent.click(feature);
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const sent = mutateAsync.mock.calls[0][0];
    expect(sent.features).toEqual({
      'translation-preserve-formatting': { enabled: true },
    });
    expect(sent.workflows.translation).toEqual({ enabled: true });
    expect(sent.etag).toBe('"e1"');
  });

  it('disables the feature switch while its workflow is off, keeping its value', () => {
    queryData.current = savedPolicy();
    render(<WorkflowPolicyPanel />);
    fireEvent.click(screen.getByLabelText(TRANSLATION_LABEL));
    const feature = screen.getByLabelText(FEATURE_LABEL);
    expect(feature).toBeDisabled();
    expect(feature).toBeChecked();
    expect(screen.getByText('featureNeedsWorkflow')).toBeInTheDocument();
  });
});
