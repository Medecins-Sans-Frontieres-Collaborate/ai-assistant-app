import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import toast from 'react-hot-toast';

import {
  CONTEXT_BUDGET_BOUNDS,
  CONTEXT_BUDGET_DEFAULTS,
} from '@/lib/services/contextBudget/types';

import { ContextBudgetPanel } from '@/components/Admin/ContextBudget/ContextBudgetPanel';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const reference = {
  defaults: CONTEXT_BUDGET_DEFAULTS,
  bounds: CONTEXT_BUDGET_BOUNDS,
  families: [
    { id: 'gpt', label: 'GPT' },
    { id: 'claude', label: 'Claude' },
  ],
  models: [
    {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      series: 'gpt',
      maxLength: 128_000,
      tokenLimit: 16_000,
    },
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      series: 'claude',
      maxLength: 1_000_000,
      tokenLimit: 128_000,
    },
  ],
};

let getBody: unknown;
let putResponder: (init: RequestInit) => Response;
const calls: FetchCall[] = [];

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  calls.push({ url, init });
  if (!init || init.method === undefined || init.method === 'GET') {
    return jsonResponse(200, { success: true, data: getBody });
  }
  return putResponder(init);
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ContextBudgetPanel />
    </QueryClientProvider>,
  );
}

const putCalls = () => calls.filter((c) => c.init?.method === 'PUT');
const putBody = () => JSON.parse(putCalls()[0].init!.body as string);

describe('ContextBudgetPanel', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    getBody = {
      config: null,
      etag: null,
      configUnavailable: false,
      ...reference,
    };
    putResponder = () =>
      jsonResponse(200, {
        success: true,
        data: { config: {}, etag: '"etag-2"' },
      });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the code defaults and what each model is sent under them', async () => {
    renderPanel();
    expect(await screen.findByLabelText('historyTokensLabel')).toHaveValue(
      48_000,
    );
    expect(screen.getByLabelText('historyFractionLabel')).toHaveValue(0.75);
    expect(screen.getByLabelText('minRecentMessagesLabel')).toHaveValue(3);
    expect(screen.getByTestId('budget-gpt-5.4')).toHaveTextContent('48,000');
    expect(screen.getByTestId('budget-claude-sonnet-5')).toHaveTextContent(
      '128,000',
    );
    expect(screen.getByText('neverSaved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  });

  it('shows stored overrides and recomputes the effective budgets', async () => {
    getBody = {
      config: {
        version: 1,
        budget: {
          historyTokens: 64_000,
          modelOverrides: { 'gpt-5.4': 80_000 },
        },
        updatedBy: 'global@example.com',
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
      etag: '"etag-1"',
      configUnavailable: false,
      ...reference,
    };
    renderPanel();
    expect(await screen.findByLabelText('historyTokensLabel')).toHaveValue(
      64_000,
    );
    expect(screen.getByTestId('budget-gpt-5.4')).toHaveTextContent('80,000');
  });

  it('saves only what differs from the defaults, with If-Match', async () => {
    getBody = { ...(getBody as object), etag: '"etag-1"' };
    renderPanel();
    fireEvent.change(await screen.findByLabelText('historyTokensLabel'), {
      target: { value: '64000' },
    });
    // The effective table follows the draft before anything is saved.
    expect(screen.getByTestId('budget-gpt-5.4')).toHaveTextContent('64,000');

    fireEvent.change(screen.getByLabelText('overrideModelPlaceholder'), {
      target: { value: 'gpt-5.4' },
    });
    fireEvent.change(screen.getAllByLabelText('overrideTokensPlaceholder')[1], {
      target: { value: '96000' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'addOverride' })[1]);
    expect(screen.getByTestId('budget-gpt-5.4')).toHaveTextContent('84,000'); // 112k × 0.75 ceiling

    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0].url).toBe('/api/admin/context-budget');
    expect(
      (putCalls()[0].init!.headers as Record<string, string>)['if-match'],
    ).toBe('"etag-1"');
    expect(putBody()).toEqual({
      budget: { historyTokens: 64_000, modelOverrides: { 'gpt-5.4': 96_000 } },
    });
  });

  it('reloads on a conflict instead of overwriting the other admin', async () => {
    getBody = { ...(getBody as object), etag: '"etag-1"' };
    putResponder = () => jsonResponse(409, { success: false });
    renderPanel();
    fireEvent.change(await screen.findByLabelText('minRecentMessagesLabel'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('conflictError'),
    );
    await waitFor(() =>
      expect(calls.filter((c) => !c.init?.method).length).toBeGreaterThan(1),
    );
  });
});
