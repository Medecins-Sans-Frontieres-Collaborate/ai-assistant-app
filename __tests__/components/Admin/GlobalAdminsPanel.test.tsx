import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import toast from 'react-hot-toast';

import { GlobalAdminsPanel } from '@/components/Admin/GlobalAdmins/GlobalAdminsPanel';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
// No M365 people suggest in tests → EmailAutocompleteInput renders a plain input.
vi.mock('@/client/hooks/useM365PeopleSuggest', () => ({
  useM365PeopleSuggest: () => undefined,
}));

type FetchCall = { url: string; init?: RequestInit };

const storedRoster = {
  version: 1,
  admins: ['config@example.com', 'me@example.com'],
  updatedBy: 'global@example.com',
  updatedAt: '2026-09-04T00:00:00.000Z',
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let getBody: unknown;
/** How many upcoming GETs answer 500 (the hook retries once, so 2 = error state). */
let failingGets = 0;
let putResponder: (init: RequestInit) => Response;
const calls: FetchCall[] = [];

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  calls.push({ url, init });
  if (!init || init.method === undefined || init.method === 'GET') {
    if (failingGets > 0) {
      failingGets -= 1;
      return jsonResponse(500, {});
    }
    return jsonResponse(200, { success: true, data: getBody });
  }
  return putResponder(init);
});

function renderPanel(currentMail: string | null = 'me@example.com') {
  // The hook sets `retry: 1` itself; only the delay is overridden here so the
  // retry path runs without a real 1s back-off.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GlobalAdminsPanel currentMail={currentMail} />
    </QueryClientProvider>,
  );
}

function putCalls() {
  return calls.filter((c) => c.init?.method === 'PUT');
}

describe('GlobalAdminsPanel', () => {
  beforeEach(() => {
    calls.length = 0;
    failingGets = 0;
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    getBody = {
      roster: storedRoster,
      etag: '"etag-1"',
      envAdmins: ['env@example.com'],
    };
    putResponder = () =>
      jsonResponse(200, { success: true, data: { etag: '"etag-2"' } });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists env admins read-only and config admins with a remove button each', async () => {
    renderPanel();
    expect(await screen.findByText('env@example.com')).toBeInTheDocument();
    // Env entries have no remove affordance — they are set by deployment.
    expect(
      screen.queryByRole('button', { name: 'remove env@example.com' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'remove config@example.com' }),
    ).toBeInTheDocument();
    expect(screen.getByText('envHint')).toBeInTheDocument();
    // Save is disabled until something changes.
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  });

  it('adds a normalized address, refuses duplicates and non-mails', async () => {
    renderPanel();
    await screen.findByText('config@example.com');
    const input = screen.getByLabelText('addLabel');

    fireEvent.change(input, { target: { value: 'not-a-mail' } });
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('invalidMail');
    expect(putCalls()).toHaveLength(0);

    fireEvent.change(input, { target: { value: ' Config@Example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('duplicateMail');

    fireEvent.change(input, { target: { value: ' New@Example.org ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('new@example.org')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'save' })).toBeEnabled();
  });

  it('saves the draft with If-Match and adopts the new ETag', async () => {
    renderPanel();
    await screen.findByText('config@example.com');
    fireEvent.click(
      screen.getByRole('button', { name: 'remove config@example.com' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const [put] = putCalls();
    expect(put.url).toBe('/api/admin/global-admins');
    expect((put.init!.headers as Record<string, string>)['if-match']).toBe(
      '"etag-1"',
    );
    expect(JSON.parse(put.init!.body as string)).toEqual({
      admins: ['me@example.com'],
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('saved'));
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  });

  it('on 409 toasts the conflict and reloads the stored roster over the draft', async () => {
    putResponder = () =>
      jsonResponse(409, { error: 'conflict', code: 'GLOBAL_ADMINS_CONFLICT' });
    renderPanel();
    await screen.findByText('config@example.com');
    fireEvent.click(
      screen.getByRole('button', { name: 'remove config@example.com' }),
    );
    expect(screen.queryByText('config@example.com')).not.toBeInTheDocument();

    // The refetch must return a NEW object so the render-time seed fires.
    getBody = {
      roster: { ...storedRoster, updatedAt: '2026-09-04T00:01:00.000Z' },
      etag: '"etag-9"',
      envAdmins: ['env@example.com'],
    };
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('conflict'));
    // The stale draft is replaced by the reloaded roster.
    expect(await screen.findByText('config@example.com')).toBeInTheDocument();
  });

  it('surfaces a server-side lockout as its own message', async () => {
    putResponder = () =>
      jsonResponse(400, { error: 'lockout', code: 'GLOBAL_ADMINS_LOCKOUT' });
    renderPanel();
    await screen.findByText('config@example.com');
    fireEvent.click(
      screen.getByRole('button', { name: 'remove config@example.com' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('lockout'));
  });

  it('predicts a lockout: with no env admins the last entry cannot be saved away', async () => {
    getBody = {
      roster: { ...storedRoster, admins: ['only@example.com'] },
      etag: '"etag-1"',
      envAdmins: [],
    };
    renderPanel('only@example.com');
    await screen.findByText('only@example.com');
    expect(screen.getByText('envEmpty')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'remove only@example.com' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('lockoutWarning');
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    expect(putCalls()).toHaveLength(0);
  });

  it('warns before save when the draft removes the editing admin', async () => {
    renderPanel('me@example.com');
    await screen.findByText('me@example.com');
    expect(screen.queryByText('selfRemovalWarning')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'remove me@example.com' }),
    );
    expect(screen.getByText('selfRemovalWarning')).toBeInTheDocument();
    // Still allowed: someone else (env@example.com) remains.
    expect(screen.getByRole('button', { name: 'save' })).toBeEnabled();
  });

  it('shows a retryable error when the roster cannot be loaded', async () => {
    failingGets = 2;
    renderPanel();
    expect(await screen.findByText('loadError')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(await screen.findByText('config@example.com')).toBeInTheDocument();
  });
});
