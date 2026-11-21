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
    // With no limits saved, the defaults shown are what is saved.
    expect(sent.features).toEqual({
      'translation-preserve-formatting': {
        enabled: true,
        limits: {
          defaultBatchPages: 6,
          maxBatchPages: 50,
          maxDocumentPages: 50,
        },
      },
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

  const limitField = (key: string, within: HTMLElement = document.body) =>
    [...within.querySelectorAll('label')]
      .find((label) => label.textContent?.includes(`.limits.${key}`))
      ?.querySelector('input') as HTMLInputElement;
  const save = () =>
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

  it('shows saved limits and saves a change to one', async () => {
    queryData.current = savedPolicy({
      'translation-preserve-formatting': {
        enabled: true,
        limits: {
          defaultBatchPages: 4,
          maxBatchPages: 8,
          maxDocumentPages: 20,
        },
      } as never,
    });
    render(<WorkflowPolicyPanel />);
    expect(limitField('maxBatchPages').value).toBe('8');
    fireEvent.change(limitField('maxDocumentPages'), {
      target: { value: '40' },
    });
    save();
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(
      mutateAsync.mock.calls[0][0].features['translation-preserve-formatting'],
    ).toEqual({
      enabled: true,
      limits: { defaultBatchPages: 4, maxBatchPages: 8, maxDocumentPages: 40 },
    });
  });

  it('does not save a limit outside its range', async () => {
    queryData.current = savedPolicy();
    render(<WorkflowPolicyPanel />);
    // 100 is the compiled ceiling for a document; one more is refused.
    fireEvent.change(limitField('maxDocumentPages'), {
      target: { value: '101' },
    });
    save();
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.change(limitField('maxDocumentPages'), {
      target: { value: '100' },
    });
    save();
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });

  it('saves an override with only the limits it sets, and drops one naming nobody', async () => {
    queryData.current = savedPolicy();
    render(<WorkflowPolicyPanel />);
    const add = screen.getByRole('button', { name: 'overrideAdd' });
    fireEvent.click(add);
    fireEvent.click(add);
    const first = screen.getByTestId(
      'feature-override-translation-preserve-formatting-0',
    );
    fireEvent.change(
      first.querySelector('input[type="text"]') as HTMLInputElement,
      { target: { value: 'lead@example.org, deputy@example.org' } },
    );
    fireEvent.change(limitField('maxDocumentPages', first), {
      target: { value: '60' },
    });
    // The second override is left without anyone to apply to.
    save();
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(
      mutateAsync.mock.calls[0][0].features['translation-preserve-formatting']
        .overrides,
    ).toEqual([
      {
        scope: 'user',
        targets: ['lead@example.org', 'deputy@example.org'],
        limits: { maxDocumentPages: 60 },
      },
    ]);
  });

  it('shows saved overrides and removes one', async () => {
    queryData.current = savedPolicy({
      'translation-preserve-formatting': {
        enabled: true,
        overrides: [
          {
            scope: 'domain',
            targets: ['example.org'],
            limits: { maxBatchPages: 10 },
          },
        ],
      } as never,
    });
    render(<WorkflowPolicyPanel />);
    const row = screen.getByTestId(
      'feature-override-translation-preserve-formatting-0',
    );
    expect(row.querySelector('select')).toHaveValue('domain');
    expect(limitField('maxBatchPages', row).value).toBe('10');
    // A limit the override leaves out shows what it inherits.
    expect(limitField('maxDocumentPages', row).placeholder).toBe(
      'overrideInherit',
    );
    fireEvent.click(screen.getByRole('button', { name: 'overrideRemove' }));
    save();
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(
      mutateAsync.mock.calls[0][0].features['translation-preserve-formatting']
        .overrides,
    ).toBeUndefined();
  });
});
