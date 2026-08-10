/**
 * Pagination, debounced search and sort behavior of the M365 file picker.
 * The m365Client boundary is mocked; translations resolve to their key names
 * via the global next-intl mock, so assertions use raw keys.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { listDrivePage, listSites } from '@/client/services/m365/m365Client';

import type { M365DriveEntry, M365DrivePage } from '@/types/m365';

import M365FilePickerModal from '@/components/Chat/ChatInput/M365FilePickerModal';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { attachDriveItemMock } = vi.hoisted(() => ({
  attachDriveItemMock: vi.fn(),
}));

vi.mock('@/client/hooks/chat/useM365Attachment', () => ({
  useM365Attachment: () => ({ attachDriveItem: attachDriveItemMock }),
}));

vi.mock('@/client/services/m365/m365Client', () => {
  class M365ClientError extends Error {
    constructor(
      message: string,
      readonly code?: string,
    ) {
      super(message);
      this.name = 'M365ClientError';
    }
  }
  return {
    M365ClientError,
    M365_SEARCH_DEBOUNCE_MS: 300,
    M365_SEARCH_MIN_CHARS: 2,
    listDrivePage: vi.fn(),
    listDrive: vi.fn(),
    listSites: vi.fn(),
    searchSites: vi.fn(),
    listSiteDrives: vi.fn(),
    listJoinedTeams: vi.fn(),
    getTeamDrive: vi.fn(),
  };
});

const listDrivePageMock = vi.mocked(listDrivePage);
const listSitesMock = vi.mocked(listSites);

function entry(itemId: string, name: string, isFolder = false): M365DriveEntry {
  return { driveId: 'd1', itemId, name, isFolder };
}

function page(entries: M365DriveEntry[], nextToken?: string): M365DrivePage {
  return { entries, ...(nextToken && { nextToken }) };
}

function searchCalls() {
  return listDrivePageMock.mock.calls.filter(([view]) => view === 'search');
}

function renderPicker() {
  return render(<M365FilePickerModal isOpen onClose={vi.fn()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  listDrivePageMock.mockResolvedValue(page([]));
  listSitesMock.mockResolvedValue({ followed: [], sites: [] });
  // The picker persists its location into the real store singleton; reset it
  // so one test's navigation can't become the next test's starting point.
  useSettingsStore.getState().setM365PickerLocation(null);
  useSettingsStore.getState().setM365SaveDestination(null);
  useUIStore.getState().setIsSettingsOpen(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('M365FilePickerModal pagination', () => {
  it('loads the first page with default sort and shows Load more when a token exists', async () => {
    listDrivePageMock.mockResolvedValueOnce(
      page([entry('a', 'alpha.txt'), entry('b', 'Bravo', true)], 'tok1'),
    );
    renderPicker();
    await screen.findByText('alpha.txt');
    expect(listDrivePageMock).toHaveBeenCalledWith('children', {
      driveId: undefined,
      itemId: undefined,
      sort: 'name',
      dir: 'asc',
    });
    expect(screen.getByText('loadMore')).toBeInTheDocument();
  });

  it('appends deduped entries and keeps loaded rows when Load more fails', async () => {
    listDrivePageMock.mockResolvedValueOnce(
      page([entry('a', 'alpha.txt')], 'tok1'),
    );
    renderPicker();
    await screen.findByText('alpha.txt');

    // Duplicate item on page 2 must not produce a second row.
    listDrivePageMock.mockResolvedValueOnce(
      page([entry('a', 'alpha.txt'), entry('c', 'charlie.txt')], 'tok2'),
    );
    fireEvent.click(screen.getByText('loadMore'));
    await screen.findByText('charlie.txt');
    expect(screen.getAllByText('alpha.txt')).toHaveLength(1);
    expect(listDrivePageMock).toHaveBeenLastCalledWith('children', {
      pageToken: 'tok1',
      q: undefined,
    });

    // Failure keeps existing rows and offers an inline retry.
    listDrivePageMock.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByText('loadMore'));
    await screen.findByText('loadMoreFailed');
    expect(screen.getByText('alpha.txt')).toBeInTheDocument();
    expect(screen.getByText('charlie.txt')).toBeInTheDocument();

    listDrivePageMock.mockResolvedValueOnce(page([entry('d', 'delta.txt')]));
    fireEvent.click(screen.getByText('retry'));
    await screen.findByText('delta.txt');
    // Last page: no token, so the sentinel button disappears.
    expect(screen.queryByText('loadMore')).not.toBeInTheDocument();
  });
});

describe('M365FilePickerModal search', () => {
  it('debounces search-as-you-type and enforces the 2-char minimum', async () => {
    vi.useFakeTimers();
    renderPicker();
    await act(async () => {});

    const input = screen.getByPlaceholderText('searchPlaceholder');
    fireEvent.change(input, { target: { value: 'g' } });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(searchCalls()).toHaveLength(0);
    expect(screen.getByText('searchMinChars')).toBeInTheDocument();

    listDrivePageMock.mockResolvedValue(page([entry('x', 'geo.pptx')]));
    fireEvent.change(input, { target: { value: 'ge' } });
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(searchCalls()).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0][1]).toMatchObject({ q: 'ge', driveId: undefined });
    expect(searchCalls()[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText('geo.pptx')).toBeInTheDocument();
  });

  it('Enter searches immediately but still enforces the minimum length', async () => {
    vi.useFakeTimers();
    renderPicker();
    await act(async () => {});

    const input = screen.getByPlaceholderText('searchPlaceholder');
    fireEvent.change(input, { target: { value: 'g' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await act(async () => {});
    expect(searchCalls()).toHaveLength(0);

    listDrivePageMock.mockResolvedValue(page([entry('x', 'geo.pptx')]));
    fireEvent.change(input, { target: { value: 'ge' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await act(async () => {});
    // No debounce wait — and the pending debounce timer must not double-fire.
    expect(searchCalls()).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(searchCalls()).toHaveLength(1);
  });
});

describe('M365FilePickerModal sort pills', () => {
  it('refetches page 1 with the selected field and flips direction on re-click', async () => {
    renderPicker();
    await waitFor(() => expect(listDrivePageMock).toHaveBeenCalled());

    fireEvent.click(screen.getByText('sort.modified'));
    await waitFor(() =>
      expect(listDrivePageMock).toHaveBeenLastCalledWith('children', {
        driveId: undefined,
        itemId: undefined,
        sort: 'lastModified',
        dir: 'desc',
      }),
    );
    expect(screen.getByText('sort.modified').closest('button')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByText('sort.modified'));
    await waitFor(() =>
      expect(listDrivePageMock).toHaveBeenLastCalledWith('children', {
        driveId: undefined,
        itemId: undefined,
        sort: 'lastModified',
        dir: 'asc',
      }),
    );
  });

  it('hides sort pills on the recent tab', async () => {
    renderPicker();
    await waitFor(() => expect(listDrivePageMock).toHaveBeenCalled());
    expect(screen.getByText('sort.name')).toBeInTheDocument();

    fireEvent.click(screen.getByText('tabs.recent'));
    await waitFor(() =>
      expect(listDrivePageMock).toHaveBeenLastCalledWith('recent'),
    );
    expect(screen.queryByText('sort.name')).not.toBeInTheDocument();
  });
});

describe('M365FilePickerModal search sections', () => {
  it('groups server results by match kind and surfaces cached local hits', async () => {
    const { recordDriveEntries, clearDriveNameCache } =
      await import('@/client/services/m365/driveNameCache');
    clearDriveNameCache();
    // Cached from an earlier session view; not in the server response.
    recordDriveEntries([
      {
        driveId: 'd1',
        itemId: 'local1',
        name: 'geo-local.pptx',
        isFolder: false,
      },
      // Also in server results — must dedupe out of the local section.
      { driveId: 'd1', itemId: 'x', name: 'geo.pptx', isFolder: false },
    ]);
    vi.useFakeTimers();
    renderPicker();
    await act(async () => {});

    listDrivePageMock.mockResolvedValue(
      page([
        {
          ...entry('x', 'geo.pptx'),
          match: 'name' as const,
          sourceLabel: 'HR',
          parentPath: 'Policies/2026',
        },
        { ...entry('y', 'minutes.docx'), match: 'content' as const },
      ]),
    );
    fireEvent.change(screen.getByPlaceholderText('searchPlaceholder'), {
      target: { value: 'geo' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText('sections.fromRecent')).toBeInTheDocument();
    // Source + path line distinguishes same-named files across sites.
    expect(screen.getByText('HR › Policies/2026')).toBeInTheDocument();
    expect(screen.getByText('geo-local.pptx')).toBeInTheDocument();
    expect(screen.getByText('sections.nameMatches')).toBeInTheDocument();
    expect(screen.getByText('sections.contentMatches')).toBeInTheDocument();
    // Dedupe: geo.pptx renders once (server section), not in local hits.
    expect(screen.getAllByText('geo.pptx')).toHaveLength(1);
    clearDriveNameCache();
  });
});

describe('M365FilePickerModal file-type filter', () => {
  it('disables non-matching files, keeps matching files and folders live', async () => {
    const onPick = vi.fn();
    listDrivePageMock.mockResolvedValueOnce(
      page([
        entry('a', 'notes.docx'),
        entry('b', 'clip.mp4'),
        entry('c', 'Folder', true),
      ]),
    );
    render(
      <M365FilePickerModal
        isOpen
        onClose={vi.fn()}
        onPick={onPick}
        acceptExtensions={['mp4', 'mp3']}
      />,
    );
    await screen.findByText('clip.mp4');
    expect(screen.getByText('notes.docx').closest('button')).toBeDisabled();
    expect(screen.getByText('clip.mp4').closest('button')).toBeEnabled();
    expect(screen.getByText('Folder').closest('button')).toBeEnabled();

    fireEvent.click(screen.getByText('clip.mp4'));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'clip.mp4' }),
    );
  });
});

describe('M365FilePickerModal type-filter chips', () => {
  it('hides non-matching files behind a chip but keeps folders, and toggles off', async () => {
    listDrivePageMock.mockResolvedValueOnce(
      page([
        entry('a', 'report.pdf'),
        entry('b', 'notes.docx'),
        entry('c', 'Folder', true),
      ]),
    );
    renderPicker();
    await screen.findByText('report.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'typeFilter.pdf' }));
    expect(screen.queryByText('notes.docx')).not.toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('Folder')).toBeInTheDocument();
    // No refetch — the filter is display-side for browse listings.
    expect(
      listDrivePageMock.mock.calls.filter(([v]) => v === 'children'),
    ).toHaveLength(1);

    // Clicking the active chip clears the filter.
    fireEvent.click(screen.getByRole('button', { name: 'typeFilter.pdf' }));
    expect(screen.getByText('notes.docx')).toBeInTheDocument();
  });

  it('selects an extra type from the "…" menu and clears from the empty state', async () => {
    listDrivePageMock.mockResolvedValueOnce(page([entry('a', 'report.pdf')]));
    renderPicker();
    await screen.findByText('report.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'typeFilter.more' }));
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'typeFilter.image' }),
    );
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('typeFilter.noMatches')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'typeFilter.all' }));
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });

  it('sends the group extensions with searches and drops folders from results', async () => {
    vi.useFakeTimers();
    renderPicker();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'typeFilter.pdf' }));
    listDrivePageMock.mockResolvedValue(
      page([entry('x', 'geo.pdf'), entry('f', 'geo-folder', true)]),
    );
    const input = screen.getByPlaceholderText('searchPlaceholder');
    fireEvent.change(input, { target: { value: 'geo' } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0][1]).toMatchObject({ q: 'geo', types: ['pdf'] });
    expect(screen.getByText('geo.pdf')).toBeInTheDocument();
    // A type-filtered search shows files of that kind, not folders.
    expect(screen.queryByText('geo-folder')).not.toBeInTheDocument();
  });

  it('offers no type chips in folder mode', async () => {
    render(
      <M365FilePickerModal isOpen onClose={vi.fn()} onPickFolder={vi.fn()} />,
    );
    await act(async () => {});
    expect(
      screen.queryByRole('button', { name: 'typeFilter.pdf' }),
    ).not.toBeInTheDocument();
  });
});

describe('M365FilePickerModal teams tab', () => {
  it('lists joined teams and browses the picked team drive', async () => {
    const { listJoinedTeams, getTeamDrive } =
      await import('@/client/services/m365/m365Client');
    vi.mocked(listJoinedTeams).mockResolvedValue([
      { groupId: 'g1', name: 'Logistics' },
    ]);
    vi.mocked(getTeamDrive).mockResolvedValue({
      driveId: 'teamdrive-1',
      name: 'Documents',
    });
    listDrivePageMock.mockResolvedValue(page([entry('a', 'plan.xlsx')]));
    renderPicker();
    fireEvent.click(await screen.findByText('tabs.teams'));
    fireEvent.click(await screen.findByText('Logistics'));
    await screen.findByText('plan.xlsx');
    expect(listDrivePageMock).toHaveBeenLastCalledWith('children', {
      driveId: 'teamdrive-1',
      itemId: undefined,
      sort: 'name',
      dir: 'asc',
    });
  });
});

describe('M365FilePickerModal folder mode', () => {
  it('shrinks to two tabs, disables file rows and titles as a folder pick', async () => {
    listDrivePageMock.mockResolvedValueOnce(
      page([entry('a', 'alpha.txt'), entry('b', 'Bravo', true)]),
    );
    render(
      <M365FilePickerModal isOpen onClose={vi.fn()} onPickFolder={vi.fn()} />,
    );
    await screen.findByText('alpha.txt');
    expect(screen.getByText('folderTitle')).toBeInTheDocument();
    // The footer location label repeats the root name, so scope to tabs.
    expect(
      screen.getByRole('tab', { name: 'tabs.onedrive' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'tabs.sharepoint' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('tabs.recent')).not.toBeInTheDocument();
    expect(screen.queryByText('tabs.shared')).not.toBeInTheDocument();
    expect(screen.getByText('alpha.txt').closest('button')).toBeDisabled();
    expect(screen.getByText('Bravo').closest('button')).toBeEnabled();
  });

  it('selects a browsed folder row with a breadcrumb pathLabel and closes', async () => {
    const onPickFolder = vi.fn();
    const onClose = vi.fn();
    listDrivePageMock.mockResolvedValueOnce(page([entry('b', 'Bravo', true)]));
    render(
      <M365FilePickerModal
        isOpen
        onClose={onClose}
        onPickFolder={onPickFolder}
      />,
    );
    await screen.findByText('Bravo');
    fireEvent.click(screen.getByText('selectFolder'));
    expect(onPickFolder).toHaveBeenCalledWith({
      driveId: 'd1',
      itemId: 'b',
      name: 'Bravo',
      pathLabel: 'tabs.onedrive › Bravo',
      // Picker trail recorded so the next folder-mode opening starts here.
      tab: 'onedrive',
      crumbs: [{ label: 'Bravo', driveId: 'd1', itemId: 'b' }],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('footer select is disabled at the OneDrive root and picks the open folder', async () => {
    const onPickFolder = vi.fn();
    listDrivePageMock.mockResolvedValue(page([entry('b', 'Bravo', true)]));
    render(
      <M365FilePickerModal
        isOpen
        onClose={vi.fn()}
        onPickFolder={onPickFolder}
      />,
    );
    await screen.findByText('Bravo');
    // The root itself is not addressable — its driveId is never known here.
    expect(screen.getByText('selectCurrentFolder')).toBeDisabled();

    fireEvent.click(screen.getByText('Bravo'));
    await waitFor(() =>
      expect(listDrivePageMock).toHaveBeenLastCalledWith('children', {
        driveId: 'd1',
        itemId: 'b',
        sort: 'name',
        dir: 'asc',
      }),
    );
    const footerButton = screen.getByText('selectCurrentFolder');
    expect(footerButton).toBeEnabled();
    fireEvent.click(footerButton);
    expect(onPickFolder).toHaveBeenCalledWith({
      driveId: 'd1',
      itemId: 'b',
      name: 'Bravo',
      pathLabel: 'tabs.onedrive › Bravo',
      tab: 'onedrive',
      crumbs: [{ label: 'Bravo', driveId: 'd1', itemId: 'b' }],
    });
  });

  it('search results offer no per-row Select — folders only navigate', async () => {
    vi.useFakeTimers();
    listDrivePageMock.mockResolvedValue(page([]));
    render(
      <M365FilePickerModal isOpen onClose={vi.fn()} onPickFolder={vi.fn()} />,
    );
    await act(async () => {});

    listDrivePageMock.mockResolvedValue(page([entry('f', 'Found', true)]));
    fireEvent.change(screen.getByPlaceholderText('searchPlaceholder'), {
      target: { value: 'fo' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('Found')).toBeInTheDocument();
    expect(screen.queryByText('selectFolder')).not.toBeInTheDocument();
  });
});

describe('M365FilePickerModal location memory', () => {
  it('opens at the remembered location with its sort and breadcrumb', async () => {
    useSettingsStore.getState().setM365PickerLocation({
      tab: 'onedrive',
      crumbs: [{ label: 'Bravo', driveId: 'd1', itemId: 'b' }],
      sort: 'lastModified',
      dir: 'desc',
    });
    listDrivePageMock.mockResolvedValue(page([entry('a', 'deep.txt')]));
    renderPicker();
    await screen.findByText('deep.txt');
    expect(listDrivePageMock).toHaveBeenCalledWith('children', {
      driveId: 'd1',
      itemId: 'b',
      sort: 'lastModified',
      dir: 'desc',
    });
    // Restored crumbs render, so the way back home is visible immediately.
    const breadcrumbs = screen.getByRole('navigation');
    expect(within(breadcrumbs).getByText('Bravo')).toBeInTheDocument();
    expect(within(breadcrumbs).getByText('tabs.onedrive')).toBeInTheDocument();
  });

  it('falls back to the root when the remembered folder no longer loads', async () => {
    useSettingsStore.getState().setM365PickerLocation({
      tab: 'onedrive',
      crumbs: [{ label: 'Gone', driveId: 'd1', itemId: 'gone' }],
      sort: 'name',
      dir: 'asc',
    });
    listDrivePageMock.mockImplementation(async (view, opts) => {
      if (view === 'children' && opts?.itemId === 'gone')
        throw new Error('itemNotFound');
      return page([entry('r', 'root.txt')]);
    });
    renderPicker();
    await screen.findByText('root.txt');
    // Fail-open: no error surfaces, and the stale location is dropped.
    expect(screen.queryByText('errors.generic')).not.toBeInTheDocument();
    expect(useSettingsStore.getState().m365PickerLocation).toMatchObject({
      crumbs: [],
    });
  });

  it('writes location on navigation but never on search, and rebases search-hit folders with an elided gap', async () => {
    vi.useFakeTimers();
    listDrivePageMock.mockResolvedValue(page([entry('b', 'Bravo', true)]));
    renderPicker();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Bravo' }));
    await act(async () => {});
    expect(useSettingsStore.getState().m365PickerLocation).toMatchObject({
      tab: 'onedrive',
      crumbs: [{ label: 'Bravo', driveId: 'd1', itemId: 'b' }],
    });

    listDrivePageMock.mockResolvedValue(page([entry('f', 'Found', true)]));
    fireEvent.change(screen.getByPlaceholderText('searchPlaceholder'), {
      target: { value: 'fo' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('Found')).toBeInTheDocument();
    // Searching didn't move the remembered location.
    expect(useSettingsStore.getState().m365PickerLocation).toMatchObject({
      crumbs: [{ label: 'Bravo' }],
    });

    // A search hit's real path is unknown: the trail rebases on the hit
    // with an inert "…" marking the gap instead of a fabricated path.
    fireEvent.click(screen.getByText('Found'));
    await act(async () => {});
    expect(screen.getByText('…')).toBeInTheDocument();
    expect(screen.queryByText('Bravo')).not.toBeInTheDocument();
    expect(useSettingsStore.getState().m365PickerLocation).toMatchObject({
      crumbs: [{ label: 'Found', elided: true }],
    });
  });
});

describe('M365FilePickerModal multi-select', () => {
  it('batches checked files into one Attach and closes once', async () => {
    const onClose = vi.fn();
    listDrivePageMock.mockResolvedValue(
      page([
        entry('a', 'alpha.txt'),
        entry('c', 'charlie.txt'),
        entry('b', 'Bravo', true),
      ]),
    );
    render(<M365FilePickerModal isOpen onClose={onClose} />);
    await screen.findByText('alpha.txt');
    // Files get checkboxes; the folder gets an alignment spacer only.
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByText('attachSelected')).toBeInTheDocument();

    // With a selection active, row clicks grow it instead of instant-attaching.
    fireEvent.click(screen.getByText('charlie.txt'));
    expect(attachDriveItemMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('attachSelected'));
    expect(attachDriveItemMock).toHaveBeenCalledTimes(2);
    expect(attachDriveItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alpha.txt' }),
    );
    expect(attachDriveItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'charlie.txt' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still instantly attaches a row click when nothing is selected', async () => {
    const onClose = vi.fn();
    listDrivePageMock.mockResolvedValue(page([entry('a', 'alpha.txt')]));
    render(<M365FilePickerModal isOpen onClose={onClose} />);
    await screen.findByText('alpha.txt');
    fireEvent.click(screen.getByText('alpha.txt'));
    expect(attachDriveItemMock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('offers no checkboxes outside attach mode', async () => {
    listDrivePageMock.mockResolvedValue(page([entry('a', 'alpha.txt')]));
    render(<M365FilePickerModal isOpen onClose={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText('alpha.txt');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('M365FilePickerModal keyboard navigation', () => {
  it('ArrowDown moves focus from the search box into and through the list', async () => {
    listDrivePageMock.mockResolvedValue(
      page([entry('a', 'alpha.txt'), entry('c', 'charlie.txt')]),
    );
    renderPicker();
    await screen.findByText('alpha.txt');

    const input = screen.getByPlaceholderText('searchPlaceholder');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByText('alpha.txt').closest('button')).toHaveFocus();

    fireEvent.keyDown(screen.getByText('alpha.txt').closest('button')!, {
      key: 'ArrowDown',
    });
    expect(screen.getByText('charlie.txt').closest('button')).toHaveFocus();

    fireEvent.keyDown(screen.getByText('charlie.txt').closest('button')!, {
      key: 'ArrowUp',
    });
    expect(screen.getByText('alpha.txt').closest('button')).toHaveFocus();
  });
});

describe('M365FilePickerModal sort truthfulness', () => {
  it('deactivates the pills and shows a note when the server dropped the sort', async () => {
    listDrivePageMock.mockResolvedValueOnce({
      entries: [entry('a', 'alpha.txt')],
      sortApplied: false,
    });
    renderPicker();
    await screen.findByText('alpha.txt');
    expect(screen.getByText('sort.notApplied')).toBeInTheDocument();
    // No pill may claim an order the rows don't have.
    expect(screen.getByText('sort.name').closest('button')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('shows no note when the sort was applied (sortApplied omitted)', async () => {
    listDrivePageMock.mockResolvedValueOnce(page([entry('a', 'alpha.txt')]));
    renderPicker();
    await screen.findByText('alpha.txt');
    expect(screen.queryByText('sort.notApplied')).not.toBeInTheDocument();
    expect(screen.getByText('sort.name').closest('button')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('M365FilePickerModal SharePoint site search', () => {
  it('shows a no-results message and clears stale sites below the minimum query', async () => {
    const { searchSites } = await import('@/client/services/m365/m365Client');
    const searchSitesMock = vi.mocked(searchSites);
    vi.useFakeTimers();
    renderPicker();
    await act(async () => {});
    fireEvent.click(screen.getByRole('tab', { name: 'tabs.sharepoint' }));
    await act(async () => {});
    // Default browse mock is empty → the empty-browse state, not the hint.
    expect(screen.getByText('sitesEmpty')).toBeInTheDocument();

    // Zero hits: a completed search must not show the browse/hint state.
    searchSitesMock.mockResolvedValueOnce([]);
    const input = screen.getByPlaceholderText('searchSitesPlaceholder');
    fireEvent.change(input, { target: { value: 'hr' } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // In-flight site searches are abortable (cancelSearch can cancel them).
    expect(searchSitesMock).toHaveBeenCalledWith('hr', expect.any(AbortSignal));
    expect(screen.getByText('sitesNoResults')).toBeInTheDocument();
    expect(screen.queryByText('sitesEmpty')).not.toBeInTheDocument();

    // A hit, then clearing the query resets the results, not just the state.
    searchSitesMock.mockResolvedValueOnce([{ siteId: 's1', name: 'HR Site' }]);
    fireEvent.change(input, { target: { value: 'hr site' } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('HR Site')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {});
    expect(screen.queryByText('HR Site')).not.toBeInTheDocument();
    expect(screen.getByText('sitesEmpty')).toBeInTheDocument();
  });
});

describe('M365FilePickerModal SharePoint browse', () => {
  it('renders followed and all-sites sections on entering the tab', async () => {
    listSitesMock.mockResolvedValueOnce({
      followed: [{ siteId: 'f1', name: 'Team HQ' }],
      sites: [{ siteId: 's1', name: 'Ops' }],
    });
    renderPicker();
    fireEvent.click(
      await screen.findByRole('tab', { name: 'tabs.sharepoint' }),
    );
    await screen.findByText('Team HQ');
    expect(screen.getByText('sections.followedSites')).toBeInTheDocument();
    expect(screen.getByText('sections.allSites')).toBeInTheDocument();
    expect(screen.getByText('Ops')).toBeInTheDocument();
    expect(listSitesMock).toHaveBeenCalledWith();
  });

  it('omits the followed section when there are no followed sites', async () => {
    listSitesMock.mockResolvedValueOnce({
      followed: [],
      sites: [{ siteId: 's1', name: 'Ops' }],
    });
    renderPicker();
    fireEvent.click(
      await screen.findByRole('tab', { name: 'tabs.sharepoint' }),
    );
    await screen.findByText('Ops');
    expect(
      screen.queryByText('sections.followedSites'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('sections.allSites')).toBeInTheDocument();
  });

  it('pages the all-sites list, keeping rows on failure with a retry', async () => {
    listSitesMock.mockResolvedValueOnce({
      followed: [],
      sites: [{ siteId: 's1', name: 'Ops' }],
      nextToken: 'st1',
    });
    renderPicker();
    fireEvent.click(
      await screen.findByRole('tab', { name: 'tabs.sharepoint' }),
    );
    await screen.findByText('Ops');

    // Failure keeps loaded rows and offers an inline retry.
    listSitesMock.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByText('loadMore'));
    await screen.findByText('loadMoreFailed');
    expect(screen.getByText('Ops')).toBeInTheDocument();

    // Retry replays the token; the append dedupes and drops the token.
    listSitesMock.mockResolvedValueOnce({
      sites: [
        { siteId: 's1', name: 'Ops' },
        { siteId: 's2', name: 'Legal' },
      ],
    });
    fireEvent.click(screen.getByText('retry'));
    await screen.findByText('Legal');
    expect(listSitesMock).toHaveBeenLastCalledWith('st1');
    expect(screen.getAllByText('Ops')).toHaveLength(1);
    expect(screen.queryByText('loadMore')).not.toBeInTheDocument();
  });

  it('search overrides browse; clearing the query restores it without a refetch', async () => {
    const { searchSites } = await import('@/client/services/m365/m365Client');
    const searchSitesMock = vi.mocked(searchSites);
    vi.useFakeTimers();
    listSitesMock.mockResolvedValue({
      followed: [],
      sites: [{ siteId: 's1', name: 'Ops' }],
    });
    renderPicker();
    await act(async () => {});
    fireEvent.click(screen.getByRole('tab', { name: 'tabs.sharepoint' }));
    await act(async () => {});
    expect(screen.getByText('Ops')).toBeInTheDocument();
    const browseCalls = listSitesMock.mock.calls.length;

    searchSitesMock.mockResolvedValueOnce([{ siteId: 'x1', name: 'HR Hit' }]);
    fireEvent.change(screen.getByPlaceholderText('searchSitesPlaceholder'), {
      target: { value: 'hr' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('HR Hit')).toBeInTheDocument();
    expect(screen.queryByText('Ops')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('searchSitesPlaceholder'), {
      target: { value: '' },
    });
    await act(async () => {});
    expect(screen.getByText('Ops')).toBeInTheDocument();
    expect(screen.queryByText('HR Hit')).not.toBeInTheDocument();
    // The browse listing came back from the session cache, not a refetch.
    expect(listSitesMock.mock.calls.length).toBe(browseCalls);
  });

  it('shows a typed error with retry when the browse listing fails to load', async () => {
    listSitesMock.mockRejectedValueOnce(new Error('boom'));
    renderPicker();
    fireEvent.click(
      await screen.findByRole('tab', { name: 'tabs.sharepoint' }),
    );
    await screen.findByText('errors.generic');

    listSitesMock.mockResolvedValueOnce({
      followed: [],
      sites: [{ siteId: 's1', name: 'Ops' }],
    });
    fireEvent.click(screen.getByText('retry'));
    await screen.findByText('Ops');
  });
});

describe('M365FilePickerModal type-filter auto-scan state', () => {
  it('explains the scan and offers a way out when the filter empties loaded pages', async () => {
    listDrivePageMock.mockResolvedValueOnce(
      page([entry('a', 'notes.docx'), entry('b', 'draft.docx')], 'tok1'),
    );
    renderPicker();
    await screen.findByText('notes.docx');

    fireEvent.click(screen.getByRole('button', { name: 'typeFilter.pdf' }));
    expect(screen.getByText('typeFilter.scanning')).toBeInTheDocument();
    // The manual pagination affordance stays available alongside the scan.
    expect(screen.getByText('loadMore')).toBeInTheDocument();

    // The stop affordance clears the filter and restores the loaded rows.
    fireEvent.click(screen.getByRole('button', { name: 'typeFilter.all' }));
    expect(screen.getByText('notes.docx')).toBeInTheDocument();
    expect(screen.queryByText('typeFilter.scanning')).not.toBeInTheDocument();
  });
});

describe('M365FilePickerModal type-menu Escape', () => {
  it('closes the open "…" menu first and only closes the modal when no menu is open', async () => {
    const onClose = vi.fn();
    listDrivePageMock.mockResolvedValue(page([entry('a', 'report.pdf')]));
    render(<M365FilePickerModal isOpen onClose={onClose} />);
    await screen.findByText('report.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'typeFilter.more' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // Focus returns to the menu button so keyboard users keep their place.
    expect(
      screen.getByRole('button', { name: 'typeFilter.more' }),
    ).toHaveFocus();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('M365FilePickerModal tablist a11y', () => {
  it('implements roving tabindex, aria-controls and arrow-key activation', async () => {
    renderPicker();
    await waitFor(() => expect(listDrivePageMock).toHaveBeenCalled());

    const onedriveTab = screen.getByRole('tab', { name: 'tabs.onedrive' });
    const recentTab = screen.getByRole('tab', { name: 'tabs.recent' });
    expect(onedriveTab).toHaveAttribute('tabindex', '0');
    expect(recentTab).toHaveAttribute('tabindex', '-1');
    expect(onedriveTab).toHaveAttribute('aria-controls', 'm365-picker-panel');
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      onedriveTab.id,
    );

    fireEvent.keyDown(onedriveTab, { key: 'ArrowRight' });
    await waitFor(() =>
      expect(recentTab).toHaveAttribute('aria-selected', 'true'),
    );
    expect(recentTab).toHaveFocus();
    expect(recentTab).toHaveAttribute('tabindex', '0');
    expect(onedriveTab).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(recentTab, { key: 'ArrowLeft' });
    await waitFor(() =>
      expect(onedriveTab).toHaveAttribute('aria-selected', 'true'),
    );
    // Returning to a searchable tab remounts the search box, whose
    // intentional autoFocus wins over the tab (pre-existing behavior).
    expect(screen.getByPlaceholderText('searchPlaceholder')).toHaveFocus();
  });
});

describe('M365FilePickerModal row metadata formatting', () => {
  it('formats sizes through Intl and labels folder child counts', async () => {
    listDrivePageMock.mockResolvedValue(
      page([
        { ...entry('a', 'big.bin'), size: 1572864 },
        { ...entry('b', 'Folder', true), childCount: 3 },
      ]),
    );
    renderPicker();
    await screen.findByText('big.bin');
    // en locale from the global mock; other locales localize the separator.
    expect(screen.getByText('1.5 MB')).toBeInTheDocument();
    // Folder counts are labeled, not a bare number in the size column.
    expect(screen.getByText('itemCount')).toBeInTheDocument();
  });
});

describe('M365FilePickerModal connection error CTA', () => {
  it('deep-links consent errors to Settings and closes the picker', async () => {
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    const onClose = vi.fn();
    listDrivePageMock.mockRejectedValueOnce(
      new M365ClientError('consent', 'M365_CONSENT_MISSING'),
    );
    render(<M365FilePickerModal isOpen onClose={onClose} />);
    await screen.findByText('errors.consentMissing');

    fireEvent.click(
      screen.getByRole('button', { name: 'errors.openConnections' }),
    );
    expect(useUIStore.getState().isSettingsOpen).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('offers no settings CTA for generic errors', async () => {
    listDrivePageMock.mockRejectedValueOnce(new Error('boom'));
    renderPicker();
    await screen.findByText('errors.generic');
    expect(
      screen.queryByRole('button', { name: 'errors.openConnections' }),
    ).not.toBeInTheDocument();
  });
});

describe('M365FilePickerModal search continuation pages', () => {
  it('keeps untiered load-more entries out of Content matches', async () => {
    vi.useFakeTimers();
    renderPicker();
    await act(async () => {});

    listDrivePageMock.mockResolvedValueOnce(
      page([{ ...entry('x', 'zeta.pptx'), match: 'name' as const }], 'tok1'),
    );
    fireEvent.change(screen.getByPlaceholderText('searchPlaceholder'), {
      target: { value: 'zeta' },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('sections.nameMatches')).toBeInTheDocument();
    expect(
      screen.queryByText('sections.contentMatches'),
    ).not.toBeInTheDocument();

    // Continuation pages come back without `match`; they must land under a
    // neutral header, not masquerade as content matches.
    listDrivePageMock.mockResolvedValueOnce(page([entry('y', 'zeta-2.pptx')]));
    fireEvent.click(screen.getByText('loadMore'));
    await act(async () => {});
    expect(screen.getByText('zeta-2.pptx')).toBeInTheDocument();
    expect(
      screen.queryByText('sections.contentMatches'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('sections.moreResults')).toBeInTheDocument();
  });
});

describe('M365FilePickerModal folder-mode location memory', () => {
  it('opens at the remembered save destination when its trail was recorded', async () => {
    useSettingsStore.getState().setM365SaveDestination({
      driveId: 'd9',
      itemId: 'f9',
      name: 'Reports',
      pathLabel: 'tabs.onedrive › Reports',
      tab: 'onedrive',
      crumbs: [{ label: 'Reports', driveId: 'd9', itemId: 'f9' }],
    });
    listDrivePageMock.mockResolvedValue(page([entry('r', 'report.docx')]));
    render(
      <M365FilePickerModal isOpen onClose={vi.fn()} onPickFolder={vi.fn()} />,
    );
    await screen.findByText('report.docx');
    expect(listDrivePageMock).toHaveBeenCalledWith('children', {
      driveId: 'd9',
      itemId: 'f9',
      sort: 'name',
      dir: 'asc',
    });
    // The trail renders so the destination is recognizable and escapable.
    const breadcrumbs = screen.getByRole('navigation');
    expect(within(breadcrumbs).getByText('Reports')).toBeInTheDocument();
  });

  it('falls back to the root when the remembered destination no longer loads', async () => {
    useSettingsStore.getState().setM365SaveDestination({
      driveId: 'd9',
      itemId: 'gone',
      name: 'Gone',
      pathLabel: 'tabs.onedrive › Gone',
      tab: 'onedrive',
      crumbs: [{ label: 'Gone', driveId: 'd9', itemId: 'gone' }],
    });
    listDrivePageMock.mockImplementation(async (view, opts) => {
      if (view === 'children' && opts?.itemId === 'gone')
        throw new Error('itemNotFound');
      return page([entry('r', 'root.txt')]);
    });
    render(
      <M365FilePickerModal isOpen onClose={vi.fn()} onPickFolder={vi.fn()} />,
    );
    await screen.findByText('root.txt');
    expect(screen.queryByText('errors.generic')).not.toBeInTheDocument();
  });

  it('starts at the root for destinations persisted without a trail', async () => {
    useSettingsStore.getState().setM365SaveDestination({
      driveId: 'd9',
      itemId: 'f9',
      name: 'Reports',
      pathLabel: 'tabs.onedrive › Reports',
    });
    listDrivePageMock.mockResolvedValue(page([entry('r', 'root.txt')]));
    render(
      <M365FilePickerModal isOpen onClose={vi.fn()} onPickFolder={vi.fn()} />,
    );
    await screen.findByText('root.txt');
    expect(listDrivePageMock).toHaveBeenCalledWith('children', {
      driveId: undefined,
      itemId: undefined,
      sort: 'name',
      dir: 'asc',
    });
  });
});
