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
