import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import {
  AnalyticsFileDto,
  AnalyticsTreeResponse,
} from '@/lib/services/analytics/dto';
import { FolderView } from '@/lib/services/analytics/viewModel';

import { AnalyticsViewer } from '@/components/Analytics/AnalyticsViewer';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const world = vi.hoisted(() => ({
  tree: null as unknown,
  filesByFolder: {} as Record<string, unknown[]>,
  requested: [] as (string | null)[],
}));

vi.mock('@/client/hooks/analytics/useAnalytics', () => ({
  useAnalyticsTree: () => ({
    data: world.tree,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useAnalyticsFiles: (folder: string | null) => {
    world.requested.push(folder);
    return {
      data:
        folder === null
          ? undefined
          : {
              folder,
              access: 'download',
              files: world.filesByFolder[folder] ?? [],
            },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  // The folder's trend: nothing to plot in these tests.
  useAnalyticsTrend: () => ({ data: undefined }),
  analyticsDownloadUrl: (id: string) => `/api/analytics/download?id=${id}`,
}));

function folderView(
  path: string,
  overrides: Partial<FolderView> = {},
): FolderView {
  return {
    path,
    name: path.split('/').pop() ?? '',
    description: '',
    access: 'download',
    pathOnly: false,
    fileCount: 0,
    configured: true,
    ...overrides,
  };
}

function file(overrides: Partial<AnalyticsFileDto> = {}): AnalyticsFileDto {
  return {
    id: 'a'.repeat(32),
    name: 'ocba_report_2026-07-01_to_2026-07-31.xlsx',
    size: 1351424,
    period: { from: '2026-07-01', to: '2026-07-31' },
    deliveredAt: '2026-08-03T08:00:00.000Z',
    expiresAt: '2028-08-01T00:00:00.000Z',
    canDownload: true,
    downloadBlock: null,
    canPreview: false,
    canExport: false,
    canViewDashboard: false,
    ...overrides,
  };
}

function setTree(tree: Partial<AnalyticsTreeResponse>) {
  world.tree = {
    folders: [],
    canAdmin: false,
    groupsDegraded: false,
    deliveryUnavailable: false,
    ...tree,
  };
}

describe('AnalyticsViewer', () => {
  beforeEach(() => {
    world.filesByFolder = {};
    world.requested = [];
    setTree({});
  });

  it('says so when nothing has been shared, rather than showing an empty table', () => {
    render(<AnalyticsViewer />);
    expect(screen.getByText('emptyTitle')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // No admin link for someone who is not one.
    expect(screen.queryByText('manage')).not.toBeInTheDocument();
  });

  it('opens the first folder that has files and offers the download', () => {
    setTree({
      folders: [
        folderView('', { access: 'none', pathOnly: true }),
        folderView('usage', { access: 'none', pathOnly: true }),
        folderView('usage/ocba', { fileCount: 1 }),
      ],
    });
    world.filesByFolder['usage/ocba'] = [file()];
    render(<AnalyticsViewer />);

    expect(world.requested).toContain('usage/ocba');
    const link = screen.getByRole('link', { name: /downloadAria/ });
    expect(link).toHaveAttribute(
      'href',
      `/api/analytics/download?id=${'a'.repeat(32)}`,
    );
    // A whole-month period reads as the month.
    expect(screen.getByText('July 2026')).toBeInTheDocument();
    // The ancestor is shown for orientation but cannot be opened.
    expect(screen.queryByRole('button', { name: /^usage$/ })).toBeNull();
  });

  it('explains why a file cannot be downloaded instead of offering a dead link', () => {
    setTree({ folders: [folderView('usage/ocba', { fileCount: 1 })] });
    world.filesByFolder['usage/ocba'] = [
      file({ canDownload: false, downloadBlock: 'hidden-fields' }),
    ];
    render(<AnalyticsViewer />);
    expect(screen.queryByRole('link', { name: /downloadAria/ })).toBeNull();
    expect(screen.getByText('block.hidden-fields')).toBeInTheDocument();
  });

  it('offers to open a file that has a preview, and the export when the original is withheld', () => {
    setTree({ folders: [folderView('usage/ocba', { fileCount: 2 })] });
    world.filesByFolder['usage/ocba'] = [
      file({ id: 'b'.repeat(32), name: 'plain.xlsx' }),
      file({
        id: 'c'.repeat(32),
        name: 'withheld.xlsx',
        canPreview: true,
        canExport: true,
        canDownload: false,
        downloadBlock: 'hidden-fields',
      }),
    ];
    render(<AnalyticsViewer />);
    // No preview → the name is plain text, not a dead button.
    expect(screen.queryByRole('button', { name: /plain\.xlsx/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: /openAria/ }),
    ).toBeInTheDocument();
    // Instead of "can't download": the way to the filtered export.
    expect(screen.getByText('openForExport')).toBeInTheDocument();
    expect(screen.queryByText('block.hidden-fields')).not.toBeInTheDocument();
  });

  it('switches folder on click', () => {
    setTree({
      folders: [
        folderView('rebilling', { fileCount: 1 }),
        folderView('usage', { fileCount: 0 }),
      ],
    });
    render(<AnalyticsViewer />);
    fireEvent.click(screen.getByRole('button', { name: /usage/ }));
    expect(world.requested.at(-1)).toBe('usage');
    expect(screen.getByText('noFiles')).toBeInTheDocument();
  });

  it('warns when groups or storage could not be read', () => {
    setTree({ groupsDegraded: true, deliveryUnavailable: true });
    render(<AnalyticsViewer />);
    expect(screen.getByText('groupsDegraded')).toBeInTheDocument();
    expect(screen.getByText('deliveryUnavailable')).toBeInTheDocument();
  });

  it('shows an admin where a file stands for everyone else, and the way to the admin page', () => {
    setTree({
      canAdmin: true,
      folders: [folderView('usage/ocba', { access: 'admin', fileCount: 1 })],
    });
    world.filesByFolder['usage/ocba'] = [
      file({
        admin: {
          validation: 'error',
          expired: false,
          issues: [],
          originalBlock: null,
        },
      }),
    ];
    render(<AnalyticsViewer />);
    expect(screen.getByText('adminBadge.error')).toBeInTheDocument();
    expect(screen.getByText('manage').closest('a')).toHaveAttribute(
      'href',
      '/admin/analytics',
    );
  });
});
