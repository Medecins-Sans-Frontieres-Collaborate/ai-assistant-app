import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { M365Status } from '@/types/m365';

import { ConnectionsSection } from '@/components/Settings/Sections/ConnectionsSection';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// All capability flags on, so every feature row is visible.
vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({
    filesEnabled: true,
    mailEnabled: true,
    agentsEnabled: true,
    translationEnabled: true,
    transcriptionEnabled: true,
    docSyncEnabled: true,
    meetingsEnabled: true,
    toolsEnabled: true,
    playbooksEnabled: true,
    sharingEnabled: true,
    backupEnabled: true,
  }),
}));

const { mockFetchM365Status } = vi.hoisted(() => ({
  mockFetchM365Status: vi.fn<() => Promise<M365Status>>(),
}));
vi.mock('@/client/services/m365/m365Client', () => ({
  fetchM365Status: mockFetchM365Status,
}));

const allGranted: M365Status = {
  features: {
    files: 'granted',
    sharepoint: 'granted',
    sharepointWrite: 'granted',
    mail: 'granted',
    mailDrafts: 'granted',
    calendar: 'granted',
    people: 'granted',
    orgDirectory: 'granted',
    tasks: 'granted',
    meetings: 'granted',
    teamsChats: 'granted',
    teamsChannels: 'granted',
    groups: 'granted',
  },
};

// The global next-intl mock has no m365.connections messages, so `t(key)`
// falls back to the key itself — assertions below use the key strings.
describe('ConnectionsSection', () => {
  beforeEach(() => {
    mockFetchM365Status.mockReset();
    useSettingsStore.setState({
      m365Connected: true,
      m365SharedMailboxes: [],
    });
  });

  it('renders a status badge per feature row after a successful fetch', async () => {
    mockFetchM365Status.mockResolvedValue(allGranted);

    render(<ConnectionsSection />);

    // Badges replace the "…" placeholders once the status arrives.
    expect(await screen.findAllByText('statusGranted')).not.toHaveLength(0);
    expect(screen.getByText('features.files')).toBeInTheDocument();
    expect(screen.getByText('features.groups')).toBeInTheDocument();
    expect(screen.queryByText('…')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a persistent inline error — not the "…" loading placeholder — when the status fetch fails', async () => {
    mockFetchM365Status.mockRejectedValue(new Error('status route down'));

    render(<ConnectionsSection />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('statusLoadFailed');
    // Failure is distinct from loading: no rows stuck on "…".
    expect(screen.queryByText('…')).not.toBeInTheDocument();
    expect(screen.queryByText('statusGranted')).not.toBeInTheDocument();
    // The existing Re-check button remains as the retry affordance.
    expect(screen.getByRole('button', { name: 'recheck' })).toBeInTheDocument();
  });

  it('recovers via Re-check: a successful retry clears the error and renders badges', async () => {
    mockFetchM365Status
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(allGranted);

    render(<ConnectionsSection />);
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'recheck' }));

    expect(await screen.findAllByText('statusGranted')).not.toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockFetchM365Status).toHaveBeenCalledTimes(2);
  });
});
