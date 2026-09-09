/**
 * Two-mode listing behaviour of the "Attach from a meeting" picker.
 *
 * The m365Client boundary is mocked (with the real `M365ClientError` kept,
 * because the modal branches on `instanceof`); translations resolve to their
 * key names via the global next-intl mock in vitest.setup.dom.ts, so every
 * copy assertion below is on a raw key rather than English prose.
 *
 * The contract being pinned: the filtered listing is the default and arrives
 * with resources inline (expanding costs no round trip), "show all" drops
 * back to the plain listing and its original lazy per-meeting resolve, and a
 * filtered listing that fails for consent reasons silently degrades to the
 * plain one instead of dead-ending on an error screen.
 */
import {
  act,
  configure,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import {
  fetchMeetingTranscript,
  importMeetingRecording,
  listMeetings,
  listMeetingsWithArtifacts,
  resolveMeeting,
} from '@/client/services/m365/m365Client';
import type { M365ImportedUploadRef } from '@/client/services/m365/m365Client';

import type {
  M365FilteredMeetingList,
  M365MeetingCandidate,
  M365MeetingEntry,
  M365MeetingResources,
  M365MeetingTranscript,
} from '@/types/m365';

import M365MeetingImportModal from '@/components/Chat/ChatInput/M365MeetingImportModal';

import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { attachImportedUpload, toastError, toastSuccess } = vi.hoisted(() => ({
  attachImportedUpload: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/client/hooks/chat/useM365Attachment', () => ({
  useM365Attachment: () => ({ attachImportedUpload }),
}));

vi.mock('react-hot-toast', () => ({
  default: { error: toastError, success: toastSuccess },
}));

// importOriginal so the real M365ClientError class survives — the modal's
// fallback/denied branches are `instanceof` checks against it.
vi.mock('@/client/services/m365/m365Client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/client/services/m365/m365Client')>();
  return {
    ...actual,
    listMeetings: vi.fn(),
    listMeetingsWithArtifacts: vi.fn(),
    resolveMeeting: vi.fn(),
    fetchMeetingTranscript: vi.fn(),
    importMeetingRecording: vi.fn(),
  };
});

const listMeetingsMock = vi.mocked(listMeetings);
const listFilteredMock = vi.mocked(listMeetingsWithArtifacts);
const resolveMeetingMock = vi.mocked(resolveMeeting);
const fetchTranscriptMock = vi.mocked(fetchMeetingTranscript);
const importRecordingMock = vi.mocked(importMeetingRecording);

function entry(
  overrides: Partial<M365MeetingEntry> & { eventId: string },
): M365MeetingEntry {
  return {
    subject: `Meeting ${overrides.eventId}`,
    joinWebUrl: `https://teams.example/${overrides.eventId}`,
    start: '2026-08-30T09:00:00Z',
    end: '2026-08-30T10:00:00Z',
    organizer: 'Ana Diaz',
    ...overrides,
  };
}

function resources(
  overrides: Partial<M365MeetingResources> = {},
): M365MeetingResources {
  return {
    meetingId: 'online-meeting-1',
    transcripts: [],
    recordings: [],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<M365MeetingCandidate> & { eventId: string },
): M365MeetingCandidate {
  return {
    ...entry(overrides),
    availability: 'available',
    ...overrides,
  };
}

function page(
  overrides: Partial<M365FilteredMeetingList> = {},
): M365FilteredMeetingList {
  return { meetings: [], hiddenCount: 0, unprobedCount: 0, ...overrides };
}

function renderModal() {
  const onClose = vi.fn();
  const onImportTranscript = vi.fn();
  const view = render(
    <M365MeetingImportModal
      isOpen
      onClose={onClose}
      onImportTranscript={onImportTranscript}
    />,
  );
  return { ...view, onClose, onImportTranscript };
}

/** The row disclosure button's accessible name starts with the subject. */
function row(subject: string) {
  return screen.getByRole('button', { name: new RegExp(subject) });
}

// Matches the sibling M365 modal tests: findBy/waitFor occasionally expire at
// the 1s default on a saturated runner even though the condition resolves.
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  vi.clearAllMocks();
  listFilteredMock.mockResolvedValue(page());
  listMeetingsMock.mockResolvedValue([]);
  resolveMeetingMock.mockResolvedValue(resources());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M365MeetingImportModal — filtered listing', () => {
  it('asks for the artifact-filtered listing on open and renders its rows', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [
          candidate({
            eventId: 'e1',
            subject: 'Weekly sync',
            resources: resources({ transcripts: [{ id: 't1' }] }),
          }),
          candidate({
            eventId: 'e2',
            subject: 'Design review',
            resources: resources({ recordings: [{ id: 'r1' }] }),
          }),
        ],
      }),
    );
    renderModal();

    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(screen.getByText('Design review')).toBeInTheDocument();
    // The default mode never touches the unfiltered listing.
    expect(listFilteredMock).toHaveBeenCalledTimes(1);
    expect(listMeetingsMock).not.toHaveBeenCalled();
    // Availability is badged straight from the server's probe.
    expect(screen.getByText('badgeTranscript')).toBeInTheDocument();
    expect(screen.getByText('badgeRecording')).toBeInTheDocument();
    expect(screen.getByText('filteringNote')).toBeInTheDocument();
  });

  it('expands an inline-resourced row without a second round trip', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [
          candidate({
            eventId: 'e1',
            subject: 'Weekly sync',
            resources: resources({
              transcripts: [{ id: 't1' }],
              recordings: [{ id: 'r1' }],
            }),
          }),
        ],
      }),
    );
    renderModal();
    await screen.findByText('Weekly sync');

    await userEvent.click(row('Weekly sync'));

    // The seeded cache answers the expand — no lazy resolve, no spinner copy.
    expect(resolveMeetingMock).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('button', { name: 'importTranscript' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'importRecording' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('checkingAvailability')).not.toBeInTheDocument();
  });

  it('keeps a forbidden meeting and expands straight to the denied copy', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [
          candidate({
            eventId: 'e1',
            subject: 'Board briefing',
            organizer: 'Ana Diaz',
            availability: 'forbidden',
            resources: undefined,
          }),
        ],
      }),
    );
    renderModal();

    // A 403 is not "empty": the row survives, badged as inaccessible.
    expect(await screen.findByText('Board briefing')).toBeInTheDocument();
    expect(screen.getByText('badgeNoAccess')).toBeInTheDocument();

    await userEvent.click(row('Board briefing'));

    expect(await screen.findByText('transcriptDenied')).toBeInTheDocument();
    expect(resolveMeetingMock).not.toHaveBeenCalled();
  });

  it('keeps a recently ended meeting as pending rather than hiding it', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [
          candidate({
            eventId: 'e1',
            subject: 'Standup',
            availability: 'pending',
            resources: resources(),
          }),
        ],
      }),
    );
    renderModal();

    expect(await screen.findByText('Standup')).toBeInTheDocument();
    expect(screen.getByText('badgePending')).toBeInTheDocument();

    await userEvent.click(row('Standup'));

    expect(await screen.findByText('pendingHint')).toBeInTheDocument();
    expect(screen.queryByText('nothingAvailable')).not.toBeInTheDocument();
    expect(resolveMeetingMock).not.toHaveBeenCalled();
  });

  it('renders one import button per transcript on a deduped recurring row', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [
          candidate({
            eventId: 'e1',
            subject: 'Recurring series',
            occurrences: 3,
            resources: resources({
              transcripts: [
                { id: 't1', created: '2026-08-30T10:05:00Z' },
                { id: 't2', created: '2026-08-23T10:05:00Z' },
                { id: 't3', created: '2026-08-16T10:05:00Z' },
              ],
            }),
          }),
        ],
      }),
    );
    renderModal();
    await screen.findByText('Recurring series');
    // The collapsed group announces how many occurrences folded into it.
    expect(screen.getByText(/occurrences/)).toBeInTheDocument();

    await userEvent.click(row('Recurring series'));

    const buttons = await screen.findAllByRole('button', {
      name: 'importTranscriptFrom',
    });
    expect(buttons).toHaveLength(3);
    // One collapsed row means one probe — and it already happened server-side.
    expect(resolveMeetingMock).not.toHaveBeenCalled();
    expect(screen.getByText('badgeTranscripts')).toBeInTheDocument();
  });
});

describe('M365MeetingImportModal — counters and escape hatch', () => {
  it('counts hidden meetings in the show-all label and surfaces the probe notes', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [candidate({ eventId: 'e1', subject: 'Weekly sync' })],
        hiddenCount: 4,
        unprobedCount: 2,
        throttled: true,
        windowTruncated: true,
      }),
    );
    renderModal();
    await screen.findByText('Weekly sync');

    expect(
      screen.getByRole('button', { name: 'showAllWithCount' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'showAll' }),
    ).not.toBeInTheDocument();
    // Unprobed meetings are unknown, not empty — they get their own note.
    expect(screen.getByText('someUnchecked')).toBeInTheDocument();
    expect(screen.getByText('throttledNote')).toBeInTheDocument();
    expect(screen.getByText('windowTruncated')).toBeInTheDocument();
  });

  it('offers the plain show-all label when nothing was hidden', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [candidate({ eventId: 'e1', subject: 'Weekly sync' })],
        hiddenCount: 0,
        unprobedCount: 0,
      }),
    );
    renderModal();
    await screen.findByText('Weekly sync');

    expect(screen.getByRole('button', { name: 'showAll' })).toBeInTheDocument();
    expect(screen.queryByText('someUnchecked')).not.toBeInTheDocument();
    expect(screen.queryByText('throttledNote')).not.toBeInTheDocument();
  });

  it('still offers the escape hatch when the filtered listing is empty', async () => {
    listFilteredMock.mockResolvedValue(page({ meetings: [] }));
    renderModal();

    expect(await screen.findByText('emptyFiltered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'showAll' })).toBeInTheDocument();
  });
});

describe('M365MeetingImportModal — mode toggle', () => {
  it('switches to the plain listing and restores the lazy per-meeting resolve', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [
          candidate({
            eventId: 'e1',
            subject: 'Weekly sync',
            resources: resources({ transcripts: [{ id: 't1' }] }),
          }),
        ],
        hiddenCount: 2,
      }),
    );
    listMeetingsMock.mockResolvedValue([
      entry({ eventId: 'e9', subject: 'Unprobed meeting' }),
    ]);
    renderModal();
    await screen.findByText('Weekly sync');

    await userEvent.click(
      screen.getByRole('button', { name: 'showAllWithCount' }),
    );

    expect(await screen.findByText('Unprobed meeting')).toBeInTheDocument();
    expect(listMeetingsMock).toHaveBeenCalledTimes(1);
    // Plain mode carries no probe verdict, so it badges nothing and shows
    // the original delegated-access note.
    expect(screen.queryByText('badgeTranscript')).not.toBeInTheDocument();
    expect(screen.getByText('delegatedNote')).toBeInTheDocument();
    expect(screen.queryByText('someUnchecked')).not.toBeInTheDocument();

    resolveMeetingMock.mockResolvedValue(
      resources({ meetingId: 'om9', transcripts: [{ id: 't9' }] }),
    );
    await userEvent.click(row('Unprobed meeting'));

    await waitFor(() =>
      expect(resolveMeetingMock).toHaveBeenCalledWith(
        'https://teams.example/e9',
      ),
    );
    expect(
      await screen.findByRole('button', { name: 'importTranscript' }),
    ).toBeInTheDocument();
  });

  it('toggles back to the filtered listing', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [candidate({ eventId: 'e1', subject: 'Weekly sync' })],
      }),
    );
    listMeetingsMock.mockResolvedValue([
      entry({ eventId: 'e9', subject: 'Unprobed meeting' }),
    ]);
    renderModal();
    await screen.findByText('Weekly sync');

    await userEvent.click(screen.getByRole('button', { name: 'showAll' }));
    await screen.findByText('Unprobed meeting');

    await userEvent.click(screen.getByRole('button', { name: 'showFiltered' }));

    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(screen.queryByText('Unprobed meeting')).not.toBeInTheDocument();
    expect(listFilteredMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('filteringNote')).toBeInTheDocument();
  });
});

describe('M365MeetingImportModal — failure handling', () => {
  it('falls back to the plain listing when the filtered call needs consent', async () => {
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    listFilteredMock.mockRejectedValue(
      new M365ClientError('nope', 'M365_CONSENT_MISSING'),
    );
    listMeetingsMock.mockResolvedValue([
      entry({ eventId: 'e9', subject: 'Unprobed meeting' }),
    ]);
    renderModal();

    // No dead error screen: the calendar listing still works, so use it.
    expect(await screen.findByText('Unprobed meeting')).toBeInTheDocument();
    expect(listMeetingsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('filterUnavailable')).toBeInTheDocument();
    expect(screen.queryByText('errors.consentMissing')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'showFiltered' }),
    ).toBeInTheDocument();
  });

  it('retires the fallback notice once a filtered retry succeeds', async () => {
    // Consent can land, or a transient 403 clear, while the modal is open.
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    listFilteredMock.mockRejectedValueOnce(
      new M365ClientError('nope', 'M365_CONSENT_MISSING'),
    );
    listMeetingsMock.mockResolvedValue([
      entry({ eventId: 'e9', subject: 'Unprobed meeting' }),
    ]);
    listFilteredMock.mockResolvedValueOnce(
      page({
        meetings: [candidate({ eventId: 'e1', subject: 'Now visible' })],
      }),
    );
    renderModal();
    expect(await screen.findByText('filterUnavailable')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'showFiltered' }));

    expect(await screen.findByText('Now visible')).toBeInTheDocument();
    expect(screen.queryByText('filterUnavailable')).not.toBeInTheDocument();
  });

  it('falls back the same way on a 403 from the filtered listing', async () => {
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    listFilteredMock.mockRejectedValue(
      new M365ClientError('denied', 'M365_FORBIDDEN'),
    );
    listMeetingsMock.mockResolvedValue([
      entry({ eventId: 'e9', subject: 'Unprobed meeting' }),
    ]);
    renderModal();

    expect(await screen.findByText('Unprobed meeting')).toBeInTheDocument();
    expect(screen.getByText('filterUnavailable')).toBeInTheDocument();
  });

  it('shows the error state for a network failure instead of falling back', async () => {
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    listFilteredMock.mockRejectedValue(
      new M365ClientError('offline', 'NETWORK'),
    );
    renderModal();

    expect(await screen.findByText('errors.network')).toBeInTheDocument();
    expect(listMeetingsMock).not.toHaveBeenCalled();
    expect(screen.queryByText('filterUnavailable')).not.toBeInTheDocument();
    // The error state is not a dead end: the mode toggle is still offered,
    // because the plain listing may well succeed where the filtered one did
    // not (and a retry costs one click).
    expect(screen.getByRole('button', { name: 'showAll' })).toBeInTheDocument();
  });

  it('recovers from a failed filtered listing through the mode toggle', async () => {
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    listFilteredMock.mockRejectedValue(
      new M365ClientError('offline', 'NETWORK'),
    );
    listMeetingsMock.mockResolvedValue([
      entry({ eventId: 'e9', subject: 'Unprobed meeting' }),
    ]);
    renderModal();
    await screen.findByText('errors.network');

    await userEvent.click(screen.getByRole('button', { name: 'showAll' }));

    // The escape hatch actually escapes: plain listing, no error copy left.
    expect(await screen.findByText('Unprobed meeting')).toBeInTheDocument();
    expect(screen.queryByText('errors.network')).not.toBeInTheDocument();
    expect(listMeetingsMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: 'showFiltered' }),
    ).toBeInTheDocument();
  });
});

describe('M365MeetingImportModal — import concurrency', () => {
  it('fires one transcript import however many times the button is clicked', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [
          candidate({
            eventId: 'e1',
            subject: 'Weekly sync',
            resources: resources({
              meetingId: 'om1',
              transcripts: [{ id: 't1' }],
              recordings: [{ id: 'r1' }],
            }),
          }),
        ],
      }),
    );
    let settle: ((value: M365MeetingTranscript) => void) | undefined;
    fetchTranscriptMock.mockReturnValue(
      new Promise<M365MeetingTranscript>((resolve) => {
        settle = resolve;
      }),
    );
    const { onClose, onImportTranscript } = renderModal();
    await screen.findByText('Weekly sync');
    await userEvent.click(row('Weekly sync'));
    const importButton = await screen.findByRole('button', {
      name: 'importTranscript',
    });

    await userEvent.click(importButton);
    await userEvent.click(importButton);
    await userEvent.click(importButton);

    // An import in flight locks every import button on the row, not just
    // the one that started it — a second import would race the first close.
    expect(fetchTranscriptMock).toHaveBeenCalledTimes(1);
    expect(importButton).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'importRecording' }),
    ).toBeDisabled();

    await act(async () => {
      settle?.({
        transcript: 'Ana: hello',
        speakers: ['Ana Diaz'],
        fileName: 'weekly-sync.txt',
      });
    });

    expect(onImportTranscript).toHaveBeenCalledTimes(1);
    expect(onImportTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'Ana: hello' }),
      expect.objectContaining({ eventId: 'e1' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires one recording import however many times the button is clicked', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [
          candidate({
            eventId: 'e1',
            subject: 'Weekly sync',
            resources: resources({
              meetingId: 'om1',
              transcripts: [{ id: 't1' }],
              recordings: [{ id: 'r1' }],
            }),
          }),
        ],
      }),
    );
    let settle: ((value: M365ImportedUploadRef) => void) | undefined;
    importRecordingMock.mockReturnValue(
      new Promise<M365ImportedUploadRef>((resolve) => {
        settle = resolve;
      }),
    );
    const { onClose } = renderModal();
    await screen.findByText('Weekly sync');
    await userEvent.click(row('Weekly sync'));
    const importButton = await screen.findByRole('button', {
      name: 'importRecording',
    });

    await userEvent.click(importButton);
    await userEvent.click(importButton);
    await userEvent.click(importButton);

    // A recording import copies bytes server-side: three of them is three
    // uploads and three toasts for one user intent.
    expect(importRecordingMock).toHaveBeenCalledTimes(1);
    expect(importButton).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'importTranscript' }),
    ).toBeDisabled();

    await act(async () => {
      settle?.({
        uri: '/api/file/blob-1',
        name: 'weekly-sync.mp4',
        size: 1234,
        mimeType: 'video/mp4',
        category: 'video',
      });
    });

    expect(attachImportedUpload).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('M365MeetingImportModal — stale writes across a mode switch', () => {
  it('re-resolves a forbidden row after switching to show-all', async () => {
    listFilteredMock.mockResolvedValue(
      page({
        meetings: [
          candidate({
            eventId: 'e1',
            subject: 'Board briefing',
            availability: 'forbidden',
            resources: undefined,
          }),
        ],
        hiddenCount: 1,
      }),
    );
    listMeetingsMock.mockResolvedValue([
      entry({ eventId: 'e1', subject: 'Board briefing' }),
    ]);
    resolveMeetingMock.mockResolvedValue(
      resources({ meetingId: 'om1', transcripts: [{ id: 't1' }] }),
    );
    renderModal();
    await screen.findByText('Board briefing');
    expect(screen.getByText('badgeNoAccess')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'showAllWithCount' }),
    );
    await screen.findByText('delegatedNote');

    await userEvent.click(row('Board briefing'));

    // The filtered listing's 403 verdict must not survive the toggle: the
    // whole point of "show all" is to reach meetings the probe could not.
    await waitFor(() =>
      expect(resolveMeetingMock).toHaveBeenCalledWith(
        'https://teams.example/e1',
      ),
    );
    expect(
      await screen.findByRole('button', { name: 'importTranscript' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('transcriptDenied')).not.toBeInTheDocument();
  });

  it('drops a lazy resolve that lands after the mode changed', async () => {
    listFilteredMock
      .mockResolvedValueOnce(
        page({
          meetings: [candidate({ eventId: 'e0', subject: 'Other meeting' })],
          hiddenCount: 1,
        }),
      )
      .mockResolvedValueOnce(
        page({
          meetings: [
            candidate({
              eventId: 'e1',
              subject: 'Weekly sync',
              resources: resources({
                meetingId: 'om-server',
                transcripts: [{ id: 'ts1' }, { id: 'ts2' }],
              }),
            }),
          ],
        }),
      );
    listMeetingsMock.mockResolvedValue([
      entry({ eventId: 'e1', subject: 'Weekly sync' }),
    ]);
    let settleStale: ((value: M365MeetingResources) => void) | undefined;
    resolveMeetingMock.mockReturnValue(
      new Promise<M365MeetingResources>((resolve) => {
        settleStale = resolve;
      }),
    );
    renderModal();
    await screen.findByText('Other meeting');

    await userEvent.click(
      screen.getByRole('button', { name: 'showAllWithCount' }),
    );
    await screen.findByText('Weekly sync');
    await userEvent.click(row('Weekly sync'));
    expect(await screen.findByText('checkingAvailability')).toBeInTheDocument();

    // Back to filtered while the lazy resolve is still outstanding; the
    // server-probed resources for the same event land in the cache.
    await userEvent.click(screen.getByRole('button', { name: 'showFiltered' }));
    await screen.findByText('badgeTranscripts');

    await act(async () => {
      settleStale?.(
        resources({ meetingId: 'om-stale', recordings: [{ id: 'r-stale' }] }),
      );
    });

    await userEvent.click(row('Weekly sync'));

    // The stale answer disagrees with the probe; the probe wins.
    expect(
      await screen.findAllByRole('button', { name: 'importTranscript' }),
    ).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: 'importRecording' }),
    ).not.toBeInTheDocument();
    expect(resolveMeetingMock).toHaveBeenCalledTimes(1);
  });
});
