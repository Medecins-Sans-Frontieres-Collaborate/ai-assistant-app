import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import toast from 'react-hot-toast';

import {
  MULTI_STEP_BOUNDS,
  MULTI_STEP_DEFAULTS,
} from '@/lib/services/webSearch/config/types';

import { WebSearchConfigPanel } from '@/components/Admin/WebSearch/WebSearchConfigPanel';

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
  defaults: MULTI_STEP_DEFAULTS,
  bounds: MULTI_STEP_BOUNDS,
  assessorModels: [
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano' },
    { id: 'Mistral-Large-3', name: 'Mistral Large 3' },
  ],
  assessorFallbackModelId: 'gpt-5.4-nano',
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
      <WebSearchConfigPanel />
    </QueryClientProvider>,
  );
}

const putCalls = () => calls.filter((c) => c.init?.method === 'PUT');
const putBody = (index = 0) =>
  JSON.parse(putCalls()[index].init!.body as string);

describe('WebSearchConfigPanel', () => {
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

  it('shows the code defaults when nothing has been saved', async () => {
    renderPanel();
    expect(await screen.findByLabelText(/enabledLabel/)).toBeChecked();
    expect(screen.getByLabelText('assessorLabel')).toHaveValue(
      'Mistral-Large-3',
    );
    expect(screen.getByLabelText('maxStepsLabel')).toHaveValue(3);
    expect(screen.getByLabelText('maxStepsExploratoryLabel')).toHaveValue(6);
    expect(screen.getByLabelText('timeBudgetLabel')).toHaveValue(90);
    expect(screen.getByText('neverSaved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  });

  it('shows stored overrides over the defaults', async () => {
    getBody = {
      config: {
        version: 1,
        multiStep: { maxSteps: 5, assessorModelId: 'gpt-5.4-mini' },
        updatedBy: 'global@example.com',
        updatedAt: '2026-09-30T00:00:00.000Z',
      },
      etag: '"etag-1"',
      configUnavailable: false,
      ...reference,
    };
    renderPanel();
    expect(await screen.findByLabelText('maxStepsLabel')).toHaveValue(5);
    expect(screen.getByLabelText('assessorLabel')).toHaveValue('gpt-5.4-mini');
    expect(screen.getByLabelText('timeBudgetLabel')).toHaveValue(90);
  });

  it('saves only what differs from the defaults, with If-Match', async () => {
    getBody = { ...(getBody as object), etag: '"etag-1"' };
    renderPanel();
    fireEvent.change(await screen.findByLabelText('maxStepsLabel'), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByLabelText('assessorLabel'), {
      target: { value: 'gpt-5.4-mini' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0].url).toBe('/api/admin/web-search');
    expect(
      (putCalls()[0].init!.headers as Record<string, string>)['if-match'],
    ).toBe('"etag-1"');
    expect(putBody()).toEqual({
      multiStep: { maxSteps: 4, assessorModelId: 'gpt-5.4-mini' },
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('switching it off disables the dependent controls and saves one flag', async () => {
    renderPanel();
    fireEvent.click(await screen.findByLabelText(/enabledLabel/));

    expect(screen.getByLabelText('assessorLabel')).toBeDisabled();
    expect(screen.getByLabelText('maxStepsLabel')).toBeDisabled();
    expect(screen.getByLabelText(/pageReadsLabel/)).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putBody()).toEqual({ multiStep: { enabled: false } });
  });

  it('clamps numbers to the bounds and lifts the exploratory cap to the normal one', async () => {
    renderPanel();
    fireEvent.change(await screen.findByLabelText('maxStepsLabel'), {
      target: { value: '99' },
    });
    expect(screen.getByLabelText('maxStepsLabel')).toHaveValue(8);

    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putBody()).toEqual({
      multiStep: { maxSteps: 8, maxStepsExploratory: 8 },
    });
  });

  it('reset to defaults saves an empty override set', async () => {
    getBody = {
      config: {
        version: 1,
        multiStep: { maxSteps: 5, enabled: false },
        updatedBy: 'global@example.com',
        updatedAt: '2026-09-30T00:00:00.000Z',
      },
      etag: '"etag-1"',
      configUnavailable: false,
      ...reference,
    };
    renderPanel();
    await screen.findByLabelText('maxStepsLabel');
    fireEvent.click(screen.getByRole('button', { name: 'resetDefaults' }));
    expect(screen.getByLabelText('maxStepsLabel')).toHaveValue(3);

    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putBody()).toEqual({ multiStep: {} });
  });

  it('on a conflict tells the admin and reloads', async () => {
    putResponder = () => jsonResponse(409, { success: false });
    renderPanel();
    fireEvent.click(await screen.findByLabelText(/enabledLabel/));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('conflictError'),
    );
    const gets = calls.filter((c) => !c.init?.method);
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it('hides the controls when the stored settings cannot be read', async () => {
    getBody = {
      config: null,
      etag: null,
      configUnavailable: true,
      ...reference,
    };
    renderPanel();
    expect(await screen.findByText('configUnavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('maxStepsLabel')).not.toBeInTheDocument();
  });
});
