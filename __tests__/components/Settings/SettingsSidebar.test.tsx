import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { Settings } from '@/types/settings';

import { SettingsSidebar } from '@/components/Settings/SettingsSidebar';
import { SettingsSection } from '@/components/Settings/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable LD flags (mirrors ConnectorsSection test pattern).
const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

// next-intl's createNavigation resolves next/navigation at import time,
// which vitest cannot load — stub the Link to a plain anchor.
vi.mock('@/lib/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Mutable admin status; the real hook needs a QueryClientProvider. The nav now
// reads admin-ness from useAdminAreas, which resolves the agent-access and
// usage-limits env flags INDEPENDENTLY server-side — deriving it from
// useAgentAccessAdmin used to hide the entry on any deployment running limits
// with agent access off.
const mockAgentAccess = { isAdmin: false };
vi.mock('@/client/hooks/settings/useAdminAreas', () => ({
  useAdminAreas: () => ({
    areas: mockAgentAccess.isAdmin ? ['agents'] : [],
    isAdmin: mockAgentAccess.isAdmin,
    configUnavailable: false,
    isLoading: false,
  }),
}));

// The setup-level next-intl mock has no `settings` namespace, so labels
// render as their raw keys ('settings.Backup' etc.) — assert on those.
function renderSidebar(setActiveSection = vi.fn()) {
  render(
    <SettingsSidebar
      activeSection={SettingsSection.GENERAL}
      setActiveSection={setActiveSection}
      handleReset={vi.fn()}
      onClose={vi.fn()}
      state={{} as Settings}
      dispatch={vi.fn()}
    />,
  );
  return setActiveSection;
}

describe('SettingsSidebar — backup nav item gating', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockFlags)) delete mockFlags[key];
    mockAgentAccess.isAdmin = false;
  });

  it('hides the Admin link for non-admins and shows it for admins', () => {
    renderSidebar();
    expect(screen.queryByText('settings.Admin')).not.toBeInTheDocument();

    mockAgentAccess.isAdmin = true;
    renderSidebar();
    // ONE entry for every admin area now, pointing at the unified shell.
    const link = screen.getByText('settings.Admin').closest('a');
    expect(link).toHaveAttribute('href', '/admin');
  });

  it('hides Backup when the flag is absent (fail-closed), unlike the fail-open Usage & Impact', () => {
    renderSidebar();

    expect(screen.queryByText('settings.Backup')).not.toBeInTheDocument();
    // Polarity divergence: with no flags served, fail-open sections show...
    expect(screen.getByText('settings.Usage & Impact')).toBeInTheDocument();
    expect(screen.getByText('settings.Connectors')).toBeInTheDocument();
  });

  it('hides Backup when the flag is explicitly false', () => {
    mockFlags.enableEncryptedBackups = false;
    renderSidebar();
    expect(screen.queryByText('settings.Backup')).not.toBeInTheDocument();
  });

  it('hides Backup on a truthy-but-not-true flag value', () => {
    mockFlags.enableEncryptedBackups = 'yes';
    renderSidebar();
    expect(screen.queryByText('settings.Backup')).not.toBeInTheDocument();
  });

  it('shows Backup only when the flag is exactly true, and navigates on click', () => {
    mockFlags.enableEncryptedBackups = true;
    const setActiveSection = renderSidebar();

    const item = screen.getByText('settings.Backup');
    expect(item).toBeInTheDocument();

    fireEvent.click(item);
    expect(setActiveSection).toHaveBeenCalledWith(SettingsSection.BACKUP);
  });
});

describe('SettingsSidebar — memories nav item gating', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockFlags)) delete mockFlags[key];
    mockAgentAccess.isAdmin = false;
  });

  it('hides Memories when the flag is absent (fail-closed)', () => {
    renderSidebar();
    expect(screen.queryByText('settings.Memories')).not.toBeInTheDocument();
  });

  it('hides Memories when the flag is explicitly false or truthy-but-not-true', () => {
    mockFlags.enableMemories = false;
    renderSidebar();
    expect(screen.queryByText('settings.Memories')).not.toBeInTheDocument();

    mockFlags.enableMemories = 'yes';
    renderSidebar();
    expect(screen.queryByText('settings.Memories')).not.toBeInTheDocument();
  });

  it('shows Memories only when the flag is exactly true, and navigates on click', () => {
    mockFlags.enableMemories = true;
    const setActiveSection = renderSidebar();

    const item = screen.getByText('settings.Memories');
    expect(item).toBeInTheDocument();

    fireEvent.click(item);
    expect(setActiveSection).toHaveBeenCalledWith(SettingsSection.MEMORIES);
  });
});
