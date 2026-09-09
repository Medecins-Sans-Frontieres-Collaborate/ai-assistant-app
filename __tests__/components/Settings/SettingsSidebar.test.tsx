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

// Mutable M365 capabilities — the real hook's localhost escape hatch would
// force the merged Connections entry visible in jsdom regardless of flags.
const mockM365 = { filesEnabled: false, mailEnabled: false };
vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({
    filesEnabled: mockM365.filesEnabled,
    mailEnabled: mockM365.mailEnabled,
  }),
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

describe('SettingsSidebar — consolidated nav gating', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockFlags)) delete mockFlags[key];
    mockAgentAccess.isAdmin = false;
    mockM365.filesEnabled = false;
    mockM365.mailEnabled = false;
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

  it('shows ONE merged Connections entry (no separate Connectors item)', () => {
    const setActiveSection = renderSidebar();
    // Fail-open mcpConnectors keeps the merged entry visible with no flags.
    expect(screen.queryByText('settings.Connectors')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('settings.Connections'));
    expect(setActiveSection).toHaveBeenCalledWith(SettingsSection.CONNECTIONS);
  });

  it('hides the merged Connections entry only when every capability is off', () => {
    mockFlags.mcpConnectors = false;
    renderSidebar();
    // m365 flags are fail-closed and unserved; mcp explicitly off → gone.
    expect(screen.queryByText('settings.Connections')).not.toBeInTheDocument();
  });

  it('labels the data pane "Data Management" without the backup flag (fail-closed)', () => {
    renderSidebar();
    expect(screen.getByText('settings.Data Management')).toBeInTheDocument();
    expect(screen.queryByText('settings.DataBackup')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.Backup')).not.toBeInTheDocument();
    // Polarity divergence: with no flags served, fail-open sections show.
    expect(screen.getByText('settings.Usage & Impact')).toBeInTheDocument();
  });

  it.each([[false], ['yes']])(
    'keeps the plain label on non-true backup flag value %p',
    (value) => {
      mockFlags.enableEncryptedBackups = value;
      renderSidebar();
      expect(screen.queryByText('settings.DataBackup')).not.toBeInTheDocument();
      expect(screen.getByText('settings.Data Management')).toBeInTheDocument();
    },
  );

  it('widens the label to "Data & Backup" when the flag is exactly true — same pane either way', () => {
    mockFlags.enableEncryptedBackups = true;
    const setActiveSection = renderSidebar();

    const item = screen.getByText('settings.DataBackup');
    expect(
      screen.queryByText('settings.Data Management'),
    ).not.toBeInTheDocument();

    fireEvent.click(item);
    expect(setActiveSection).toHaveBeenCalledWith(
      SettingsSection.DATA_MANAGEMENT,
    );
  });

  it('has no standalone Mobile App entry (folded into Help & Support)', () => {
    renderSidebar();
    expect(screen.queryByText('settings.Mobile App')).not.toBeInTheDocument();
    expect(screen.getByText('settings.Help & Support')).toBeInTheDocument();
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
