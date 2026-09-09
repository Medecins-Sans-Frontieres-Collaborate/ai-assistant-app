import { fireEvent, render, screen } from '@testing-library/react';

import { AdminShell } from '@/components/Admin/AdminShell';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetIsSettingsOpen = vi.fn();
vi.mock('@/client/hooks/ui/useUI', () => ({
  useUI: () => ({ setIsSettingsOpen: mockSetIsSettingsOpen }),
}));

let mockSegments: string[] = [];
vi.mock('next/navigation', () => ({
  useSelectedLayoutSegments: () => mockSegments,
}));

vi.mock('@/lib/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/Admin/AdminAreaNav', () => ({
  AdminAreaNav: ({ variant }: { variant: string }) => (
    <nav data-testid={`area-nav-${variant}`} />
  ),
}));

describe('AdminShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSegments = ['agents'];
  });

  it('renders the header with back link and title', () => {
    render(
      <AdminShell areas={['agents']}>
        <div>panel</div>
      </AdminShell>,
    );

    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('panel')).toBeInTheDocument();
  });

  it('opens the settings modal from the header gear', () => {
    render(
      <AdminShell areas={['agents']}>
        <div>panel</div>
      </AdminShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));

    expect(mockSetIsSettingsOpen).toHaveBeenCalledWith(true);
  });

  it('full-bleed passthrough (deep routes) renders children without header or gear', () => {
    mockSegments = ['map-datasets', 'some-id'];

    render(
      <AdminShell areas={['agents']}>
        <div>editor</div>
      </AdminShell>,
    );

    expect(screen.getByText('editor')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open settings' }),
    ).not.toBeInTheDocument();
  });
});
