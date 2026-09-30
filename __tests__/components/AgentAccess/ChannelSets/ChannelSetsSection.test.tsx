import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { ChannelSetsSection } from '@/components/AgentAccess/ChannelSets/ChannelSetsSection';
import type { AdminChannelSetsResponse } from '@/components/AgentAccess/types';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// Tone guides for the voice picker and style guides for Check; the section
// only reads the list.
vi.mock('@/client/hooks/settings/useAvailableGuides', () => ({
  useAvailableGuides: () => ({
    guides: [
      { id: 'guide-tone', kind: 'tone', name: 'Warm voice' },
      { id: 'guide-style', kind: 'style', name: 'House style' },
    ],
    isLoadingGuides: false,
  }),
}));

// A global admin: every rule key is editable, so the sending rows render.
vi.mock('@/client/hooks/settings/useAgentAccessAdmin', () => ({
  unwrapApiData: (body: unknown) =>
    body && typeof body === 'object' && 'data' in body
      ? (body as { data: unknown }).data
      : body,
  useAgentAccessAdmin: () => ({
    me: { isGlobalAdmin: true, isLocalAdmin: false, editableAgentKeys: '*' },
    isAdmin: true,
    isGlobalAdmin: true,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const platform = (id: string, name: string) => ({
  id,
  kind: 'channel' as const,
  name,
  guidance: `Guidance for ${name}`,
  maxSegments: id === 'x' ? 10 : 1,
  family: 'social' as const,
  segmentLimit: id === 'x' ? 280 : 3000,
  counting: 'graphemes' as const,
  slots: [],
  hashtags: { max: 3, placement: 'end' as const },
  links: { allowed: true, position: 'last' as const },
  threadNumbering: 'none' as const,
});

const norwaySet = {
  canonicalKey: 'channel-set::set-0123456789ab',
  etag: '"etag-1"',
  canEdit: true,
  record: {
    version: 1 as const,
    id: 'set-0123456789ab',
    name: 'MSF Norway',
    language: 'Norwegian',
    description: 'Oslo comms',
    channels: {
      linkedin: { enabled: true, guidance: 'Skriv kort.' },
      x: { enabled: false },
    },
    defaults: {
      channelIds: ['linkedin'],
      articleLink: true,
      guideIds: ['guide-style'],
    },
    isDefault: false,
    createdBy: 'oslo@example.org',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'oslo@example.org',
    updatedAt: '2026-09-02T00:00:00.000Z',
  },
};

const listing = (
  overrides: Partial<AdminChannelSetsResponse> = {},
): AdminChannelSetsResponse => ({
  sets: [norwaySet],
  virtualDefault: {
    id: 'default',
    canEdit: true,
    data: {
      name: 'Default',
      language: '',
      description: '',
      channels: { linkedin: { enabled: true }, x: { enabled: true } },
      defaults: { channelIds: [], articleLink: true, guideIds: [] },
      isDefault: true,
    },
  },
  platforms: [platform('linkedin', 'LinkedIn'), platform('x', 'X')],
  canCreate: true,
  ...overrides,
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function installFetch(
  response: AdminChannelSetsResponse = listing(),
  options: { writeStatus?: number } = {},
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === '/api/agent-access/channel-sets' && method === 'GET') {
        return jsonResponse(200, { success: true, data: response });
      }
      if (options.writeStatus && method !== 'GET') {
        return jsonResponse(options.writeStatus, {
          success: false,
          error: 'Nope',
        });
      }
      if (url === '/api/agent-access/rules') {
        return jsonResponse(200, { success: true, data: { rules: [] } });
      }
      if (url === '/api/agent-access/channel-sets') {
        return jsonResponse(200, {
          success: true,
          data: {
            record: { ...norwaySet.record, id: 'set-ffffffffffff' },
            etag: '"etag-2"',
            canonicalKey: 'channel-set::set-ffffffffffff',
          },
        });
      }
      return jsonResponse(404, { error: `unmocked ${method} ${url}` });
    }),
  );
  return calls;
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChannelSetsSection />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChannelSetsSection', () => {
  it('lists the stored sets and the built-in default', async () => {
    installFetch();
    renderSection();

    expect(await screen.findByText('MSF Norway')).toBeInTheDocument();
    // The virtual default is named as built-in and carries the Default badge.
    expect(screen.getByText('builtInName')).toBeInTheDocument();
    expect(screen.getByText('defaultBadge')).toBeInTheDocument();
    // Language, channel count and description on the summary line.
    expect(
      screen.getByText('Norwegian · channelsCount · Oslo comms'),
    ).toBeInTheDocument();
  });

  it('opens the editor with one row per platform and the set rules filled', async () => {
    installFetch();
    renderSection();
    await screen.findByText('MSF Norway');

    // Rows: the built-in default first, then MSF Norway.
    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[1]);

    // A row for every platform: the enabled one shows its guidance, the
    // disabled one only its toggle.
    expect(
      screen.getAllByRole('checkbox', { name: 'enableChannel' }),
    ).toHaveLength(2);
    expect(screen.getByDisplayValue('Skriv kort.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('MSF Norway')).toBeInTheDocument();
    // The platform's own guidance is the placeholder, never copied in.
    expect(
      screen.getByPlaceholderText('Guidance for LinkedIn'),
    ).toBeInTheDocument();
    // The tone guide is offered as a default voice.
    expect(
      screen.getByRole('option', { name: 'Warm voice' }),
    ).toBeInTheDocument();
  });

  it('saves an existing set with PUT and the If-Match etag', async () => {
    const calls = installFetch();
    renderSection();
    await screen.findByText('MSF Norway');

    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[1]);
    fireEvent.change(screen.getByDisplayValue('MSF Norway'), {
      target: { value: 'MSF Norge' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('/api/agent-access/channel-sets');
    expect(put?.headers['If-Match']).toBe('"etag-1"');
    expect(put?.body).toMatchObject({
      id: 'set-0123456789ab',
      data: { name: 'MSF Norge', language: 'Norwegian' },
    });
  });

  it('stores the built-in default with PUT and no If-Match', async () => {
    const calls = installFetch();
    renderSection();
    await screen.findByText('builtInName');

    // The built-in default is listed first; its Edit is the first one.
    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.headers['If-Match']).toBeUndefined();
    expect(put?.body).toMatchObject({
      id: 'default',
      data: { name: 'Default' },
    });
  });

  it('creates a new set with POST and no id', async () => {
    const calls = installFetch();
    renderSection();
    await screen.findByText('MSF Norway');

    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    // A blank set has no name yet, so Save waits for one.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    // The name field is the editor's first text input.
    fireEvent.change(screen.getAllByRole('textbox')[0], {
      target: { value: 'MSF USA' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.headers['If-Match']).toBeUndefined();
    expect(post?.body).toMatchObject({ data: { name: 'MSF USA' } });
    expect((post?.body as { id?: string }).id).toBeUndefined();
    // Every platform is offered until the admin prunes.
    expect(post?.body).toMatchObject({
      data: { channels: { linkedin: { enabled: true }, x: { enabled: true } } },
    });
  });

  it('duplicate pre-fills the editor with a fork of the set', async () => {
    const calls = installFetch();
    renderSection();
    await screen.findByText('MSF Norway');

    // Rows: built-in default, then MSF Norway.
    fireEvent.click(screen.getAllByRole('button', { name: 'duplicate' })[1]);
    expect(screen.getByDisplayValue('copyName')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Skriv kort.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Oslo comms')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({
      data: {
        name: 'copyName',
        isDefault: false,
        channels: { linkedin: { enabled: true, guidance: 'Skriv kort.' } },
        defaults: { channelIds: ['linkedin'], guideIds: ['guide-style'] },
      },
    });
  });

  /**
   * The built-in default is saved with no If-Match; if another admin stored
   * it meanwhile the server refuses (409 without an etag). Whatever the
   * refusal, the list is stale: reload it and say so.
   */
  it('reloads the list and reports a conflict when storing the built-in default fails', async () => {
    const calls = installFetch(listing(), { writeStatus: 409 });
    renderSection();
    await screen.findByText('builtInName');

    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('conflict');
    // The list was fetched again after the refusal.
    const lists = calls.filter(
      (call) =>
        call.method === 'GET' && call.url === '/api/agent-access/channel-sets',
    );
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });

  it('treats any refusal of the built-in default (no etag) as a conflict', async () => {
    const calls = installFetch(listing(), { writeStatus: 400 });
    renderSection();
    await screen.findByText('builtInName');

    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('conflict');
    expect(
      calls.filter((call) => call.method === 'GET').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps a stored set's refusal as the server's own message", async () => {
    installFetch(listing(), { writeStatus: 400 });
    renderSection();
    await screen.findByText('MSF Norway');

    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[1]);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nope');
  });

  it('offers the default tick only once the set exists', async () => {
    installFetch();
    renderSection();
    await screen.findByText('MSF Norway');

    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(screen.queryByRole('checkbox', { name: 'isDefault' })).toBeNull();
    expect(screen.getByText('isDefaultAfterSave')).toBeInTheDocument();

    // Cancel, then edit the stored set: the tick is there.
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[1]);
    expect(
      screen.getByRole('checkbox', { name: 'isDefault' }),
    ).toBeInTheDocument();
  });

  it('warns when a set offers no channels, without blocking', async () => {
    installFetch();
    renderSection();
    await screen.findByText('MSF Norway');

    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[1]);
    expect(screen.queryByText('noChannelsWarning')).toBeNull();
    // LinkedIn is the only enabled channel; switching it off empties the set.
    fireEvent.click(
      screen.getAllByRole('checkbox', { name: 'enableChannel' })[0],
    );
    expect(screen.getByText('noChannelsWarning')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  it('clamps the hashtag maximum to 0–30', async () => {
    const calls = installFetch();
    renderSection();
    await screen.findByText('MSF Norway');

    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[1]);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'hashtagsMax' }), {
      target: { value: '99' },
    });
    expect(screen.getByRole('spinbutton', { name: 'hashtagsMax' })).toHaveValue(
      30,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: 'hashtagsMax' }), {
      target: { value: '-4' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    });
    expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
      data: {
        channels: { linkedin: { hashtags: { max: 0, placement: 'none' } } },
      },
    });
  });

  it("duplicate leaves the source team's Hootsuite profiles behind", async () => {
    installFetch(
      listing({
        sets: [
          {
            ...norwaySet,
            record: {
              ...norwaySet.record,
              channels: {
                linkedin: { enabled: true, publishTarget: 'hs-no-li' },
                x: { enabled: false },
              },
            },
          },
        ],
      }),
    );
    renderSection();
    await screen.findByText('MSF Norway');

    // Editing the set itself shows its profile...
    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[1]);
    expect(screen.getByDisplayValue('hs-no-li')).toBeInTheDocument();

    // ...the fork opened by Duplicate does not.
    fireEvent.click(screen.getAllByRole('button', { name: 'duplicate' })[1]);
    expect(screen.getByDisplayValue('copyName')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('hs-no-li')).toBeNull();
  });

  it('explains what Everyone means for a set under the audience editor', async () => {
    installFetch();
    renderSection();
    await screen.findByText('MSF Norway');

    fireEvent.click(screen.getAllByRole('button', { name: 'whoMayUse' })[1]);
    expect(screen.getByText('audienceEveryoneHint')).toBeInTheDocument();
  });

  it('hides Edit on a set the admin may not edit but still offers Duplicate', async () => {
    installFetch(
      listing({
        sets: [{ ...norwaySet, canEdit: false }],
        virtualDefault: null,
      }),
    );
    renderSection();
    await screen.findByText('MSF Norway');

    expect(screen.queryByRole('button', { name: 'edit' })).toBeNull();
    expect(screen.getByText('readOnly')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'duplicate' }),
    ).toBeInTheDocument();
  });
});
