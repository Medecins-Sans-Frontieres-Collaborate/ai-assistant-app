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
} from '@testing-library/react';

import { listDrivePage } from '@/client/services/m365/m365Client';

import type { M365DriveEntry, M365DrivePage } from '@/types/m365';

import M365FilePickerModal from '@/components/Chat/ChatInput/M365FilePickerModal';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/chat/useM365Attachment', () => ({
  useM365Attachment: () => ({ attachDriveItem: vi.fn() }),
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
    searchSites: vi.fn(),
    listSiteDrives: vi.fn(),
  };
});

const listDrivePageMock = vi.mocked(listDrivePage);

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
