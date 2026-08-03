import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { listMail } from '@/client/services/m365/m365Client';

import type { M365MailEnvelope } from '@/types/m365';

import M365MailImportModal, {
  avatarColorClass,
  formatMailRowTime,
  mailDateGroup,
  senderInitials,
} from '@/components/Chat/ChatInput/M365MailImportModal';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const attachMail = vi.fn();

vi.mock('@/client/hooks/chat/useM365Attachment', () => ({
  useM365Attachment: () => ({ attachMail }),
}));

vi.mock('@/client/services/m365/m365Client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/client/services/m365/m365Client')>();
  return {
    M365_SEARCH_DEBOUNCE_MS: 300,
    M365_SEARCH_MIN_CHARS: 2,
    ...actual,
    listMail: vi.fn(),
  };
});

const listMailMock = vi.mocked(listMail);

function envelope(
  overrides: Partial<M365MailEnvelope> & { id: string },
): M365MailEnvelope {
  return {
    subject: `Subject ${overrides.id}`,
    from: 'Ana Diaz <ana@x.org>',
    preview: `preview ${overrides.id}`,
    hasAttachments: false,
    ...overrides,
  };
}

// The IntersectionObserver constructor is captured so tests can fire the
// sentinel-visible callback by hand.
let ioCallback: IntersectionObserverCallback | null = null;
class IntersectionObserverStub {
  constructor(callback: IntersectionObserverCallback) {
    ioCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function fireSentinel() {
  act(() => {
    ioCallback?.(
      [{ isIntersecting: true }] as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
  });
}

async function renderModal() {
  const onClose = vi.fn();
  render(<M365MailImportModal isOpen onClose={onClose} />);
  await waitFor(() => expect(listMailMock).toHaveBeenCalled());
  return onClose;
}

async function enterSearch(query: string) {
  fireEvent.change(screen.getByPlaceholderText('searchPlaceholder'), {
    target: { value: query },
  });
  await waitFor(() =>
    expect(listMailMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: query }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ioCallback = null;
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
  listMailMock.mockResolvedValue({ envelopes: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('M365MailImportModal', () => {
  it('renders sender-first rows with unread emphasis and date group headers', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    listMailMock.mockResolvedValue({
      envelopes: [
        envelope({
          id: 'm1',
          fromName: 'Ana Diaz',
          fromAddress: 'ana@x.org',
          isRead: false,
          received: now.toISOString(),
        }),
        envelope({
          id: 'm2',
          fromName: 'Bo Li',
          isRead: true,
          received: yesterday.toISOString(),
        }),
      ],
    });
    await renderModal();

    const unreadSender = await screen.findByText('Ana Diaz');
    expect(unreadSender.className).toContain('font-semibold');
    expect(screen.getByText('Bo Li').className).toContain('font-medium');
    // Unread dot announces itself for screen readers.
    expect(screen.getByText('unread')).toHaveClass('sr-only');
    // Browse mode groups by local day across the whole list.
    expect(screen.getByText('groups.today')).toBeInTheDocument();
    expect(screen.getByText('groups.yesterday')).toBeInTheDocument();
  });

  it('sends browse chip toggles to the server as filters', async () => {
    await renderModal();
    expect(listMailMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ q: expect.anything() }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'filters.unread' }));
    await waitFor(() =>
      expect(listMailMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ filters: ['unread'] }),
      ),
    );
    expect(
      screen.getByRole('button', { name: 'filters.unread' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('debounces search and fires one request for the settled query', async () => {
    await renderModal();
    const input = screen.getByPlaceholderText('searchPlaceholder');
    fireEvent.change(input, { target: { value: 'b' } });
    fireEvent.change(input, { target: { value: 'bu' } });
    fireEvent.change(input, { target: { value: 'budget' } });

    await waitFor(() =>
      expect(listMailMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'budget' }),
      ),
    );
    // Initial browse load + one settled search — intermediate keystrokes
    // never reach the network.
    expect(listMailMock).toHaveBeenCalledTimes(2);
  });

  it('filters search results locally when chips are on (no refetch)', async () => {
    await renderModal();
    listMailMock.mockResolvedValue({
      envelopes: [
        envelope({ id: 's1', fromName: 'Unread Sender', isRead: false }),
        envelope({ id: 's2', fromName: 'Read Sender', isRead: true }),
      ],
    });
    await enterSearch('budget');
    await screen.findByText('Read Sender');
    const callsAfterSearch = listMailMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'filters.unread' }));

    expect(screen.getByText('Unread Sender')).toBeInTheDocument();
    expect(screen.queryByText('Read Sender')).not.toBeInTheDocument();
    expect(screen.getByText('filtersLocalHint')).toBeInTheDocument();
    expect(listMailMock).toHaveBeenCalledTimes(callsAfterSearch);
  });

  it('shows emptySearch for zero hits and emptyFiltered when chips eliminate them', async () => {
    await renderModal();
    listMailMock.mockResolvedValue({
      envelopes: [envelope({ id: 's1', fromName: 'Read Only', isRead: true })],
    });
    await enterSearch('budget');
    await screen.findByText('Read Only');

    fireEvent.click(screen.getByRole('button', { name: 'filters.unread' }));
    expect(screen.getByText('emptyFiltered')).toBeInTheDocument();

    listMailMock.mockResolvedValue({ envelopes: [] });
    await enterSearch('nothing-matches');
    expect(await screen.findByText('emptySearch')).toBeInTheDocument();
  });

  it('expands a peek via the disclosure button without duplicating import buttons', async () => {
    listMailMock.mockResolvedValue({
      envelopes: [
        envelope({
          id: 'm1',
          conversationId: 'c1',
          preview: 'full preview body',
          to: 'Bo Li <bo@x.org>',
          cc: 'Cc Person <cc@x.org>',
          webLink: 'https://outlook.example/m1',
        }),
      ],
    });
    await renderModal();
    const disclosure = await screen.findByRole('button', {
      name: 'showDetails',
    });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(disclosure);

    expect(screen.getByRole('button', { name: 'hideDetails' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText(/Bo Li/)).toBeInTheDocument();
    expect(screen.getByText(/Cc Person/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /openInOutlook/ });
    expect(link).toHaveAttribute('href', 'https://outlook.example/m1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // The peek never duplicates the row's import buttons.
    expect(
      screen.getAllByRole('button', { name: 'importMessage' }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: 'importThread' }),
    ).toHaveLength(1);
  });

  it('imports via the compact row buttons and closes the modal', async () => {
    const mail = envelope({ id: 'm1', conversationId: 'c1' });
    listMailMock.mockResolvedValue({ envelopes: [mail] });
    const onClose = await renderModal();
    fireEvent.click(
      await screen.findByRole('button', { name: 'importThread' }),
    );
    expect(attachMail).toHaveBeenCalledWith(mail, 'thread');
    expect(onClose).toHaveBeenCalled();
  });

  it('appends deduped pages on sentinel intersection and stops on a stale page', async () => {
    listMailMock.mockResolvedValueOnce({
      envelopes: [envelope({ id: 'm1', fromName: 'First' })],
      nextToken: 't1',
    });
    await renderModal();
    await screen.findByText('First');

    // Second page repeats m1 (Graph paging quirk) and adds m2.
    listMailMock.mockResolvedValueOnce({
      envelopes: [
        envelope({ id: 'm1', fromName: 'First' }),
        envelope({ id: 'm2', fromName: 'Second' }),
      ],
      nextToken: 't2',
    });
    fireSentinel();
    await screen.findByText('Second');
    expect(listMailMock).toHaveBeenLastCalledWith({ pageToken: 't1' });
    expect(screen.getAllByText('First')).toHaveLength(1);

    // A page contributing nothing new terminates pagination even though
    // Graph handed back another token.
    listMailMock.mockResolvedValueOnce({
      envelopes: [envelope({ id: 'm2', fromName: 'Second' })],
      nextToken: 't3',
    });
    fireSentinel();
    await waitFor(() => expect(listMailMock).toHaveBeenCalledTimes(3));
    const settledCalls = listMailMock.mock.calls.length;
    fireSentinel();
    expect(listMailMock.mock.calls.length).toBe(settledCalls);
  });

  it('keeps loaded rows and offers retry when a page fetch fails', async () => {
    listMailMock.mockResolvedValueOnce({
      envelopes: [envelope({ id: 'm1', fromName: 'First' })],
      nextToken: 't1',
    });
    await renderModal();
    await screen.findByText('First');

    listMailMock.mockRejectedValueOnce(new Error('boom'));
    fireSentinel();
    const retry = await screen.findByRole('button', { name: 'retry' });
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('loadMoreError')).toBeInTheDocument();

    listMailMock.mockResolvedValueOnce({
      envelopes: [envelope({ id: 'm2', fromName: 'Second' })],
    });
    fireEvent.click(retry);
    expect(await screen.findByText('Second')).toBeInTheDocument();
  });

  it('maps client error codes to specific copy', async () => {
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    listMailMock.mockRejectedValue(
      new M365ClientError('nope', 'M365_CONSENT_MISSING'),
    );
    render(<M365MailImportModal isOpen onClose={vi.fn()} />);
    expect(
      await screen.findByText('errors.consentMissing'),
    ).toBeInTheDocument();
  });
});

describe('mail row helpers', () => {
  const now = new Date(2026, 6, 31, 15, 0, 0); // Fri 2026-07-31 local

  it('formatMailRowTime picks the bucket by local day age', () => {
    const locale = 'en';
    const today = new Date(2026, 6, 31, 9, 30).toISOString();
    expect(formatMailRowTime(today, locale, now)).toBe(
      new Date(today).toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    const thisWeek = new Date(2026, 6, 28).toISOString();
    expect(formatMailRowTime(thisWeek, locale, now)).toBe(
      new Date(thisWeek).toLocaleDateString(locale, { weekday: 'short' }),
    );
    const thisYear = new Date(2026, 1, 10).toISOString();
    expect(formatMailRowTime(thisYear, locale, now)).toBe(
      new Date(thisYear).toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
      }),
    );
    const older = new Date(2024, 1, 10).toISOString();
    expect(formatMailRowTime(older, locale, now)).toBe(
      new Date(older).toLocaleDateString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    );
    expect(formatMailRowTime(undefined, locale, now)).toBe('');
    expect(formatMailRowTime('garbage', locale, now)).toBe('');
  });

  it('mailDateGroup partitions on local midnights', () => {
    expect(mailDateGroup(new Date(2026, 6, 31, 0, 1).toISOString(), now)).toBe(
      'today',
    );
    expect(
      mailDateGroup(new Date(2026, 6, 30, 23, 59).toISOString(), now),
    ).toBe('yesterday');
    expect(mailDateGroup(new Date(2026, 6, 25).toISOString(), now)).toBe(
      'thisWeek',
    );
    expect(mailDateGroup(new Date(2026, 6, 24).toISOString(), now)).toBe(
      'earlier',
    );
    expect(mailDateGroup(undefined, now)).toBe('earlier');
  });

  it('senderInitials prefers two-word name initials, then address', () => {
    expect(
      senderInitials({ fromName: 'Ana Diaz', from: 'Ana Diaz <ana@x.org>' }),
    ).toBe('AD');
    expect(senderInitials({ fromName: 'Cher', from: 'Cher' })).toBe('C');
    expect(
      senderInitials({ fromAddress: 'zed@x.org', from: 'zed@x.org' }),
    ).toBe('Z');
    expect(senderInitials({ from: '' })).toBe('?');
  });

  it('avatarColorClass is deterministic per sender', () => {
    expect(avatarColorClass('ana@x.org')).toBe(avatarColorClass('ana@x.org'));
    expect(avatarColorClass('ana@x.org')).toMatch(/^bg-/);
  });
});

describe('M365MailImportModal expanded actions', () => {
  it('expands via the text region and offers full-size context actions', async () => {
    const { useChatInputStore } =
      await import('@/client/stores/chatInputStore');
    useChatInputStore.getState().setTextFieldValue(() => '');
    listMailMock.mockResolvedValue({
      envelopes: [
        envelope({ id: 'm1', conversationId: 'c1', to: 'you@x.org' }),
      ],
    });
    await renderModal();
    await screen.findByText('Subject m1');

    // The sender/subject region toggles expansion.
    fireEvent.click(screen.getByText('Subject m1'));
    expect(screen.getByText('actions.summarize')).toBeInTheDocument();
    expect(screen.getByText('actions.draftReply')).toBeInTheDocument();
    // Full-size import buttons render in the expanded panel too.
    expect(screen.getByText('message')).toBeInTheDocument();
    expect(screen.getByText('thread')).toBeInTheDocument();

    // Summarize: attaches the THREAD (conversationId present) and fills
    // the composer without sending.
    fireEvent.click(screen.getByText('actions.summarize'));
    expect(attachMail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1' }),
      'thread',
    );
    expect(useChatInputStore.getState().textFieldValue).toBe(
      'prompts.summarize',
    );
  });

  it('draft reply attaches the single message and carries the id in the prompt', async () => {
    const { useChatInputStore } =
      await import('@/client/stores/chatInputStore');
    useChatInputStore.getState().setTextFieldValue(() => '');
    listMailMock.mockResolvedValue({
      envelopes: [envelope({ id: 'm2', conversationId: 'c2' })],
    });
    await renderModal();
    fireEvent.click(await screen.findByText('Subject m2'));
    fireEvent.click(screen.getByText('actions.draftReply'));
    expect(attachMail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm2' }),
      'message',
    );
    expect(useChatInputStore.getState().textFieldValue).toContain(
      'prompts.draftReply',
    );
  });
});
