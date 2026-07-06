import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { AgentSourceForm } from '@/components/Chat/AgentSources/AgentSourceForm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable LaunchDarkly flags — empty by default (so `agentSourceBrowse` is
// undefined and treated as enabled, i.e. browse discovery available). Individual
// tests flip `agentSourceBrowse` to false to assert the prod manual-only path.
const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

/**
 * Routes the cascading /api/agents/browse calls (and the connection-check
 * /api/agents call) to canned responses by inspecting the request URL.
 */
function stubBrowseFetch(routes: {
  subscriptions?: unknown[];
  accounts?: unknown[];
  projects?: unknown[];
  agents?: unknown[];
}) {
  const fn = vi.fn((url: string) => {
    let body: Record<string, unknown> = { items: [] };
    if (url.includes('level=subscriptions')) {
      body = { items: routes.subscriptions ?? [] };
    } else if (url.includes('level=accounts')) {
      body = { items: routes.accounts ?? [] };
    } else if (url.includes('level=projects')) {
      body = { items: routes.projects ?? [] };
    } else if (url.includes('/api/agents?')) {
      body = { agents: routes.agents ?? [] };
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('AgentSourceForm', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset flags between tests (default: browse enabled).
    for (const k of Object.keys(mockFlags)) delete mockFlags[k];
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows inline field errors when submitting an empty form (button is clickable)', async () => {
    stubBrowseFetch({ subscriptions: [] });
    const onSave = vi.fn();

    render(<AgentSourceForm onSave={onSave} onClose={vi.fn()} />);

    // The submit button is never disabled for "incomplete" — only while validating.
    const connect = await screen.findByRole('button', { name: /connect/i });
    expect(connect).not.toBeDisabled();

    fireEvent.click(connect);

    // Missing-field feedback appears inline (keys render verbatim under the mock).
    expect(await screen.findByText('nameRequired')).toBeInTheDocument();
    expect(await screen.findByText('subscriptionRequired')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('auto-selects a lone subscription + account and seeds the name from the account', async () => {
    stubBrowseFetch({
      subscriptions: [{ id: 'sub-1', name: 'Only Subscription' }],
      accounts: [{ name: 'msf-foundry', resourceGroup: 'rg-1' }],
      projects: [{ name: 'default' }],
    });
    const onSave = vi.fn();

    render(<AgentSourceForm onSave={onSave} onClose={vi.fn()} />);

    // The single account cascades in and seeds the connection name field.
    const nameInput = (await screen.findByPlaceholderText(
      'namePlaceholder',
    )) as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('msf-foundry'));
  });

  it('offers browse discovery and fetches subscriptions when agentSourceBrowse is enabled (default)', async () => {
    const fetchFn = stubBrowseFetch({
      subscriptions: [{ id: 'sub-1', name: 'Sub One' }],
    });

    render(<AgentSourceForm onSave={vi.fn()} onClose={vi.fn()} />);

    // The browse⇄manual toggle is present (in browse mode it reads "enterManually").
    expect(
      await screen.findByRole('button', { name: 'enterManually' }),
    ).toBeInTheDocument();
    // Browse mode fetches the subscription list on mount.
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('level=subscriptions'),
      ),
    );
  });

  it('hides browse and never calls /api/agents/browse when agentSourceBrowse is false (prod)', async () => {
    mockFlags.agentSourceBrowse = false;
    const fetchFn = stubBrowseFetch({});

    render(<AgentSourceForm onSave={vi.fn()} onClose={vi.fn()} />);

    // Manual entry is forced: the subscription-id input is rendered immediately.
    expect(
      await screen.findByPlaceholderText(
        'e49ac66c-c18d-4586-b132-8f201de8f2c2',
      ),
    ).toBeInTheDocument();
    // No browse toggle in either direction.
    expect(
      screen.queryByRole('button', { name: 'enterManually' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'browseResources' }),
    ).not.toBeInTheDocument();
    // Crucially, no Azure-resource discovery call is made.
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/agents/browse'),
    );
  });
});
