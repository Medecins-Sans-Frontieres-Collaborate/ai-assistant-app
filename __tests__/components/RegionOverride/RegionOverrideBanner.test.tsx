import { render, screen } from '@testing-library/react';
import React from 'react';

import { RegionOverrideBanner } from '@/components/RegionOverride/RegionOverrideBanner';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionUser = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const adminAreas = vi.hoisted(() => ({
  current: { areas: [] as string[], isLoading: false },
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: sessionUser.current },
    status: 'authenticated',
  }),
}));
vi.mock('@/client/hooks/settings/useAdminAreas', () => ({
  useAdminAreas: () => adminAreas.current,
}));

function setUrl(search: string) {
  window.history.replaceState(null, '', `/en${search}`);
}

const originalLocation = window.location;

describe('RegionOverrideBanner', () => {
  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  beforeEach(() => {
    document.cookie = 'region_override=; path=/; max-age=0';
    setUrl('');
    adminAreas.current = { areas: [], isLoading: false };
    sessionUser.current = { region: 'EU', regionOverridden: false };
  });

  it('renders nothing when the session has no override, even if a cookie exists', () => {
    document.cookie = 'region_override=US; path=/';
    render(<RegionOverrideBanner />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the warning from the SESSION region when overridden', () => {
    sessionUser.current = { region: 'US', regionOverridden: true };
    render(<RegionOverrideBanner />);
    // The global next-intl mock returns the key for messages it doesn't
    // know, so assert the warning renders rather than its interpolated text.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('stays quiet when the region came from view-as (ViewAsBanner covers it)', () => {
    sessionUser.current = {
      region: 'US',
      regionOverridden: true,
      viewAs: { overrides: { region: 'US' }, actual: {} },
    };
    render(<RegionOverrideBanner />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('strips ?regionOverride= for a non-admin WITHOUT writing the cookie', () => {
    setUrl('?regionOverride=US&x=1');
    render(<RegionOverrideBanner />);
    expect(document.cookie).not.toContain('region_override=US');
    expect(window.location.search).toBe('?x=1');
  });

  it('applies ?regionOverride= for a real global admin', () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        reload,
        search: '?regionOverride=eu',
        pathname: '/en',
        hash: '',
      },
    });
    adminAreas.current = { areas: ['limits', 'view-as'], isLoading: false };
    render(<RegionOverrideBanner />);
    expect(document.cookie).toContain('region_override=EU');
    expect(reload).toHaveBeenCalled();
  });

  it('waits for the admin-areas query before deciding', () => {
    setUrl('?regionOverride=US');
    adminAreas.current = { areas: [], isLoading: true };
    render(<RegionOverrideBanner />);
    // Not applied AND not stripped yet — the decision is deferred.
    expect(document.cookie).not.toContain('region_override=US');
    expect(window.location.search).toBe('?regionOverride=US');
  });
});
