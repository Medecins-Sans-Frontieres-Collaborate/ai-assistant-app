import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { AgentSourceForm } from '@/components/Chat/AgentSources/AgentSourceForm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
