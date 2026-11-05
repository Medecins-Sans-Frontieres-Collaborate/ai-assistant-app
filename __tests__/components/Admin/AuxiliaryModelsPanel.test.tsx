/** Real localized editor rendering and keyboard-accessible policy interactions. */
import { fireEvent, render, screen, within } from '@testing-library/react';

import { NextIntlClientProvider } from 'next-intl';

import { auxiliaryReport } from '@/__tests__/lib/services/auxiliary/fixtures';

import { AuxiliaryModelsPanel } from '@/components/Admin/Models/AuxiliaryModelsPanel';

import english from '@/messages/en.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('next-intl');

const mocks = vi.hoisted(() => ({
  hook: vi.fn(),
  save: vi.fn(),
  refresh: vi.fn(),
  probe: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock(
  '@/client/hooks/settings/useAuxiliaryModelsAdmin',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/client/hooks/settings/useAuxiliaryModelsAdmin')
    >()),
    useAuxiliaryModelsAdmin: mocks.hook,
  }),
);
const mount = () =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ auxiliaryModels: english.auxiliaryModels }}
    >
      <AuxiliaryModelsPanel />
    </NextIntlClientProvider>,
  );
beforeEach(() => {
  vi.clearAllMocks();
  const report = auxiliaryReport();
  mocks.hook.mockReturnValue({
    query: {
      data: report,
      isLoading: false,
      isError: false,
      refetch: mocks.refetch,
    },
    save: { mutate: mocks.save, reset: vi.fn(), isPending: false },
    refresh: { mutate: mocks.refresh, isPending: false },
    probe: { mutate: mocks.probe, isPending: false },
  });
});

describe('Models and readiness', () => {
  it('shows the trusted environment and separates inventory refresh from paid checks', () => {
    mount();
    expect(
      screen.getByRole('heading', { name: 'Models and readiness', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('live')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it('marks a draft dirty without persisting until Save', () => {
    mount();
    expect(
      screen.getByRole('button', { name: 'Save assignments' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'Remove classifier from the chain',
      })[0],
    );
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save assignments' }));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ etag: null }),
      expect.anything(),
    );
  });
  it('provides named keyboard ordering controls with real boundary disabling', () => {
    mount();
    const up = screen.getAllByRole('button', { name: 'Move classifier up' });
    expect(up[0]).toBeDisabled();
    expect(
      screen.getAllByRole('button', { name: 'Move classifier down' })[0],
    ).toBeDisabled();
  });
  it('does not allow adding a new unchecked deployment', () => {
    const result = mocks.hook();
    const choice = structuredClone(result.query.data.choices.EU[0]);
    choice.reference.deploymentName = 'new-gpt';
    result.query.data.choices.EU.push(choice);
    mount();
    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'EU:new-gpt' },
    });
    expect(
      screen.getAllByRole('button', { name: 'Add to chain' })[0],
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Run this purpose's compatibility checks before adding the deployment.",
      ),
    ).toBeInTheDocument();
  });
  it('renders unavailable inventory and retained policy history without erasing the editor', () => {
    const result = mocks.hook();
    result.query.data.inventory[0].status = 'stale';
    result.query.data.inventory[0].error = 'inventory_refresh_failed';
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Readiness' }));
    expect(screen.getByText(/Inventory refresh failed/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'No policy changes have been recorded in this environment.',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('tabpanel')).getByRole('heading', {
        name: /Account binding: EU/,
      }),
    ).toBeInTheDocument();
  });
  it('disables edits when policy storage is unavailable instead of presenting defaults as authoritative', () => {
    const result = mocks.hook();
    result.query.data.configUnavailable = true;
    mount();
    expect(
      screen.getByRole('button', { name: 'Save assignments' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Policy storage is unavailable/),
    ).toBeInTheDocument();
  });
});
