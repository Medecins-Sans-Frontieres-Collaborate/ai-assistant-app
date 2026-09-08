import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';
import toast from 'react-hot-toast';

import type { ScopedLimitsView } from '@/client/hooks/settings/useLimitsAdmin';

import { LimitOverride, LimitsPolicy } from '@/lib/services/limits/types';

import { LimitsPanel } from '@/components/Limits/LimitsPanel';
import type { PolicyResponse } from '@/components/Limits/types';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

/**
 * LaunchDarkly, mutable per test. Empty by default so every pre-existing
 * case runs with the cost flags OFF (an unserved flag fails closed), exactly
 * as `useFlags()` outside an LDProvider would.
 */
const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEL_OCP = 'del-0000000000aa';
const DEL_PARIS = 'del-0000000000bb';

function override(partial: Partial<LimitOverride> = {}): LimitOverride {
  return {
    id: 'lim-0000000000a1',
    label: 'OCP interns',
    enabled: true,
    scope: 'user',
    targets: ['intern@ocp.msf.org'],
    priority: 0,
    entries: [{ limitKey: 'chat.messagesPerDay', value: 50, ceiling: false }],
    createdBy: 'ocp-admin@ocp.msf.org',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'ocp-admin@ocp.msf.org',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function scopedView(partial: Partial<ScopedLimitsView> = {}): ScopedLimitsView {
  return {
    isGlobalAdmin: false,
    mode: 'enforce',
    timezone: 'UTC',
    policyUnavailable: false,
    delegations: [
      {
        id: DEL_OCP,
        label: 'OCP',
        enabled: true,
        jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
        maxOverrides: 25,
        overrideCount: 1,
        warnings: [],
      },
    ],
    overrides: [
      {
        ...override({ delegationId: DEL_OCP }),
        delegationId: DEL_OCP,
        verdicts: [
          {
            target: 'intern@ocp.msf.org',
            status: 'in-scope',
            reason: 'domain-match',
          },
        ],
        flags: [],
      },
    ],
    ...partial,
  };
}

function policy(partial: Partial<LimitsPolicy> = {}): LimitsPolicy {
  return {
    version: 1,
    defaults: [{ limitKey: 'chat.messagesPerDay', value: 200, ceiling: false }],
    overrides: [
      override({
        label: 'Contractors',
        scope: 'domain',
        targets: ['example.org'],
        priority: 5,
      }),
    ],
    delegations: [
      {
        id: DEL_OCP,
        label: 'OCP',
        enabled: true,
        admins: ['ocp-admin@ocp.msf.org'],
        jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
        maxOverrides: 25,
        createdBy: 'global@msf.org',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'global@msf.org',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    mode: 'enforce',
    failMode: 'open',
    timezone: 'UTC',
    countByomUsage: false,
    countAuxiliaryUsage: false,
    updatedBy: 'global@msf.org',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function policyResponse(partial: Partial<PolicyResponse> = {}): PolicyResponse {
  return {
    policy: policy(),
    etag: '"e1"',
    policyUnavailable: false,
    ...partial,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

type Responder = (
  call: FetchCall,
) => { status: number; body: unknown } | undefined;

const calls: FetchCall[] = [];
let responder: Responder = () => undefined;

function installFetch() {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: FetchCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: (init?.headers as Record<string, string>) ?? {},
      };
      calls.push(call);
      const answer = responder(call) ?? {
        status: 500,
        body: { error: 'unrouted' },
      };
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body,
      } as Response;
    },
  );
  vi.stubGlobal('fetch', fetchMock);
}

function envelope(data: unknown) {
  return { success: true, data };
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LimitsPanel />
    </QueryClientProvider>,
  );
}

const putCalls = () => calls.filter((c) => c.method === 'PUT');
const getCalls = (path: string) =>
  calls.filter((c) => c.method === 'GET' && c.url === path);

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  installFetch();
  delete mockFlags.limitsCostInsights;
  delete mockFlags.limitsCostCalculator;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Scoped mode
// ---------------------------------------------------------------------------

describe('LimitsPanel — scoped mode', () => {
  function scopedRouting(
    view: ScopedLimitsView,
    extra: Responder = () => undefined,
  ) {
    responder = (call) => {
      if (call.method === 'GET' && call.url === '/api/limits/scoped') {
        return { status: 200, body: envelope(view) };
      }
      return extra(call);
    };
  }

  it('hides the defaults tab and header controls and shows the scope summary', async () => {
    scopedRouting(scopedView());
    renderPanel();

    expect(await screen.findByText('scopedDescription')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByText('modeLabel')).not.toBeInTheDocument();
    expect(screen.queryByText('failModeLabel')).not.toBeInTheDocument();
    expect(screen.queryByText('tab.defaults')).not.toBeInTheDocument();
    expect(screen.getByText('yourScopeTitle')).toBeInTheDocument();
    expect(screen.getByText('OCP interns')).toBeInTheDocument();
    // The policy document is never fetched in scoped mode.
    expect(getCalls('/api/limits/policy')).toHaveLength(0);
  });

  it('renders the post-narrowing banner and chip from the SERVER flags', async () => {
    const view = scopedView();
    view.overrides[0].flags = ['out-of-scope-targets'];
    view.overrides[0].verdicts = [
      {
        target: 'intern@ocp.msf.org',
        status: 'out-of-scope',
        reason: 'not-in-domains',
      },
    ];
    scopedRouting(view);
    renderPanel();

    expect(await screen.findByText('narrowingBanner')).toBeInTheDocument();
    expect(screen.getByText('narrowedChip')).toBeInTheDocument();
  });

  it('saves one override through the scoped endpoint with a strict body', async () => {
    scopedRouting(scopedView(), (call) => {
      if (call.method === 'PUT') {
        return {
          status: 200,
          body: envelope({ override: override(), verdicts: [] }),
        };
      }
      return undefined;
    });
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'expandOverride' }),
    );
    fireEvent.change(screen.getByLabelText('overrideLabelLabel'), {
      target: { value: 'OCP interns (renamed)' },
    });
    // Scoped variant: no priority field.
    expect(screen.queryByLabelText('priorityLabel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const put = putCalls()[0];
    expect(put.url).toBe(
      `/api/limits/scoped/overrides/lim-0000000000a1?delegation=${DEL_OCP}`,
    );
    expect(put.headers).not.toHaveProperty('If-Match');
    expect(put.body).toEqual({
      id: 'lim-0000000000a1',
      label: 'OCP interns (renamed)',
      enabled: true,
      scope: 'user',
      targets: ['intern@ocp.msf.org'],
      entries: [{ limitKey: 'chat.messagesPerDay', value: 50 }],
    });
    // Nothing the server forbids on the scoped wire.
    expect(put.body).not.toHaveProperty('priority');
    expect(put.body).not.toHaveProperty('delegationId');
    expect(put.body).not.toHaveProperty('createdBy');
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('scopedSaved'),
    );
    // The scoped view is re-read so server verdicts/flags refresh.
    await waitFor(() =>
      expect(getCalls('/api/limits/scoped').length).toBeGreaterThan(1),
    );
  });

  it('flags an out-of-scope target at authoring time, before any save', async () => {
    scopedRouting(scopedView());
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'expandOverride' }),
    );
    expect(screen.queryByText('verdictOutOfScopeChip')).not.toBeInTheDocument();

    // Add a Paris mail to an OCP-confined override.
    const input = screen.getByPlaceholderText('chipAddHint');
    fireEvent.change(input, { target: { value: 'someone@paris.msf.org' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The chip itself is flagged + header chip; no request was made.
    expect(screen.getAllByText('verdictOutOfScopeChip').length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText('someone@paris.msf.org')).toHaveAttribute(
      'title',
      'verdictOutOfScopeChip',
    );
    expect(putCalls()).toHaveLength(0);
  });

  it('renders the server LIMITS_OUT_OF_SCOPE refusal inline and as a toast', async () => {
    scopedRouting(scopedView(), (call) => {
      if (call.method === 'PUT') {
        return {
          status: 400,
          body: {
            error: 'One or more targets are outside your scope',
            code: 'LIMITS_OUT_OF_SCOPE',
            // Structured `ApiErrorDetails`, exactly as the route sends it.
            details: { outOfScope: ['intern@ocp.msf.org'] },
          },
        };
      }
      return undefined;
    });
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'expandOverride' }),
    );
    fireEvent.change(screen.getByLabelText('overrideLabelLabel'), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('saveRejectedOutOfScope'),
    );
    expect(screen.getByText('intern@ocp.msf.org')).toHaveAttribute(
      'title',
      'verdictOutOfScopeChip',
    );
    // The draft is kept for correction.
    expect(screen.getByLabelText('overrideLabelLabel')).toHaveValue('x');
  });

  it('keeps the draft and says the usual conflict sentence on 409', async () => {
    scopedRouting(scopedView(), (call) => {
      if (call.method === 'PUT') {
        return {
          status: 409,
          body: { error: 'conflict', code: 'LIMITS_CONFLICT' },
        };
      }
      return undefined;
    });
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'expandOverride' }),
    );
    fireEvent.change(screen.getByLabelText('overrideLabelLabel'), {
      target: { value: 'kept' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('conflict'));
    // Refetched, but the dirty draft survived the refetch.
    await waitFor(() =>
      expect(getCalls('/api/limits/scoped').length).toBeGreaterThan(1),
    );
    expect(screen.getByLabelText('overrideLabelLabel')).toHaveValue('kept');
  });

  /**
   * The trash icon is the same control the global panel uses for a
   * draft-only removal, but in scoped mode it is an immediate server DELETE
   * with no undo. A STORED record therefore asks first: an inline
   * alertdialog naming the override, with Cancel; only the confirm button
   * issues the DELETE.
   */
  it('asks for confirmation before deleting a stored override through the scoped endpoint', async () => {
    scopedRouting(scopedView(), (call) => {
      if (call.method === 'DELETE') {
        return { status: 200, body: envelope({ deleted: true }) };
      }
      return undefined;
    });
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'expandOverride' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'removeOverride' }));

    // One click is NOT a delete.
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('confirmDeleteOverride');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    // Cancel: dialog gone, still nothing sent, record still there.
    fireEvent.click(within(dialog).getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(screen.getByLabelText('overrideLabelLabel')).toHaveValue(
      'OCP interns',
    );

    // Confirm: exactly one DELETE to the scoped endpoint.
    fireEvent.click(screen.getByRole('button', { name: 'removeOverride' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'confirmDeleteOverrideAction',
      }),
    );

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE')).toBe(true),
    );
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe(
      '/api/limits/scoped/overrides/lim-0000000000a1',
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('scopedDeleted'),
    );
  });

  it('discards a never-saved override on the spot — nothing to confirm, no DELETE', async () => {
    scopedRouting(scopedView());
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'addOverride' }));
    const removes = screen.getAllByRole('button', { name: 'removeOverride' });
    // The new card renders expanded; it is the last trash icon.
    fireEvent.click(removes[removes.length - 1]);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    // Only the stored card remains.
    expect(
      screen.getAllByRole('button', {
        name: /expandOverride|collapseOverride/,
      }),
    ).toHaveLength(1);
  });

  it('creates a new override under the delegation and PUTs it on save', async () => {
    scopedRouting(scopedView(), (call) => {
      if (call.method === 'PUT') {
        return {
          status: 200,
          body: envelope({ override: override(), verdicts: [] }),
        };
      }
      return undefined;
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'addOverride' }));
    // The new card renders expanded with its own Save (disabled until it has a target).
    const inputs = screen.getAllByPlaceholderText('targetsPlaceholder.user');
    const target = inputs[inputs.length - 1];
    fireEvent.change(target, { target: { value: 'new@ocp.msf.org' } });
    fireEvent.keyDown(target, { key: 'Enter' });

    const saves = screen.getAllByRole('button', { name: 'save' });
    fireEvent.click(saves[saves.length - 1]);

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const put = putCalls()[0];
    expect(put.url).toMatch(
      new RegExp(
        `^/api/limits/scoped/overrides/lim-[0-9a-f]{12}\\?delegation=${DEL_OCP}$`,
      ),
    );
    expect(put.body).toMatchObject({
      targets: ['new@ocp.msf.org'],
      scope: 'user',
    });
  });

  it('shows the disabled-delegation banner and blocks writes for it', async () => {
    const view = scopedView();
    view.delegations[0].enabled = false;
    view.overrides[0].flags = ['delegation-disabled'];
    scopedRouting(view);
    renderPanel();

    expect(
      await screen.findByText('scopedDelegationDisabledBanner'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'addOverride' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  });

  it('says the group-only scope cannot be previewed by mail', async () => {
    const view = scopedView();
    view.delegations[0].jurisdiction = [
      { scope: 'group', targets: ['11111111-2222-3333-4444-555555555555'] },
    ];
    view.delegations[0].warnings = ['no-domain-or-user-anchor'];
    scopedRouting(view);
    renderPanel();

    expect(
      await screen.findByText('previewGroupOnlyScope'),
    ).toBeInTheDocument();
    expect(screen.getByText('yourScopeGroupOnlyChip')).toBeInTheDocument();
  });

  it('groups overrides by delegation when the caller has more than one', async () => {
    const view = scopedView();
    view.delegations.push({
      id: DEL_PARIS,
      label: 'Paris',
      enabled: true,
      jurisdiction: [{ scope: 'domain', targets: ['paris.msf.org'] }],
      maxOverrides: 5,
      overrideCount: 0,
      warnings: [],
    });
    scopedRouting(view);
    renderPanel();

    expect(
      await screen.findByRole('heading', { name: 'OCP' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Paris' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'addOverride' })).toHaveLength(
      2,
    );
  });

  /**
   * Design §8: a read failure must never render as an empty list that
   * implies "you have nothing configured".
   */
  it('renders policy-unavailable with Retry, never an empty list', async () => {
    scopedRouting(
      scopedView({ policyUnavailable: true, delegations: [], overrides: [] }),
    );
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'policyUnavailable',
    );
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument();
    expect(screen.queryByText('scopedNoOverrides')).not.toBeInTheDocument();
    expect(screen.queryByText('scopedNoDelegations')).not.toBeInTheDocument();
  });

  /**
   * Design §4c / §6b: scoped mode never grows a tab strip. With both cost
   * flags on the estimator is a collapsible card under the preview, checked
   * against the scoped admin's OWN overrides only, and it loads lazily —
   * nothing of it renders until the card is expanded.
   */
  it('keeps scoped mode free of a tablist and adds the calculator card only with both cost flags', async () => {
    mockFlags.limitsCostInsights = true;
    mockFlags.limitsCostCalculator = true;
    scopedRouting(scopedView());
    renderPanel();

    expect(await screen.findByText('scopedDescription')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'cost.calculator.tab' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('cost.calculator.scopedNote')).toBeInTheDocument();
    expect(screen.queryByText('cost.calculator.title')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      await screen.findByText('cost.calculator.title'),
    ).toBeInTheDocument();
    expect(getCalls('/api/limits/policy')).toHaveLength(0);
  });

  it('shows no calculator card in scoped mode with insights alone', async () => {
    mockFlags.limitsCostInsights = true;
    scopedRouting(scopedView());
    renderPanel();

    expect(await screen.findByText('scopedDescription')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'cost.calculator.tab' }),
    ).not.toBeInTheDocument();
  });

  it('treats a failed mode probe as unavailable, not as scoped mode', async () => {
    responder = () => ({ status: 403, body: { error: 'nope' } });
    renderPanel();

    // useScopedLimits retries once (1 s back-off) before surfacing the error.
    expect(
      await screen.findByRole('alert', {}, { timeout: 4000 }),
    ).toHaveTextContent('policyUnavailable');
    expect(screen.queryByText('yourScopeTitle')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Global mode
// ---------------------------------------------------------------------------

describe('LimitsPanel — global mode', () => {
  let stored: PolicyResponse;

  function globalRouting(extra: Responder = () => undefined) {
    responder = (call) => {
      if (call.method === 'GET' && call.url === '/api/limits/scoped') {
        return {
          status: 200,
          body: envelope(
            scopedView({ isGlobalAdmin: true, delegations: [], overrides: [] }),
          ),
        };
      }
      if (call.method === 'GET' && call.url === '/api/limits/policy') {
        return { status: 200, body: envelope(stored) };
      }
      return extra(call);
    };
  }

  beforeEach(() => {
    stored = policyResponse();
  });

  it('renders the full panel with a Delegations tab', async () => {
    globalRouting();
    renderPanel();

    expect(await screen.findByRole('tablist')).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'tab.defaults' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'tab.delegations' }),
    ).toBeInTheDocument();
    expect(screen.getByText('modeLabel')).toBeInTheDocument();
    expect(screen.getByText('description')).toBeInTheDocument();
  });

  it('has no Cost calculator tab while the cost flags are off', async () => {
    globalRouting();
    renderPanel();

    expect(await screen.findByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(
      screen.queryByRole('tab', { name: 'cost.calculator.tab' }),
    ).not.toBeInTheDocument();
  });

  it('has no Cost calculator tab with limitsCostCalculator alone (insights is required)', async () => {
    mockFlags.limitsCostCalculator = true;
    globalRouting();
    renderPanel();

    expect(await screen.findByRole('tablist')).toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: 'cost.calculator.tab' }),
    ).not.toBeInTheDocument();
  });

  /**
   * Design §4c: with BOTH flags on the fourth tab appears; its panel is
   * the lazily loaded calculator, cross-checked against the defaults draft.
   */
  it('adds the Cost calculator tab with both cost flags and renders the estimator in its panel', async () => {
    mockFlags.limitsCostInsights = true;
    mockFlags.limitsCostCalculator = true;
    globalRouting();
    renderPanel();

    const tab = await screen.findByRole('tab', { name: 'cost.calculator.tab' });
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    fireEvent.click(tab);

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'limits-panel-cost');
    expect(panel).toHaveAttribute('aria-labelledby', 'limits-tab-cost');
    expect(
      await within(panel).findByText('cost.calculator.title'),
    ).toBeInTheDocument();
    // Draft-based, and it says so (header and cross-check card).
    expect(
      within(panel).getAllByText('cost.calculator.draftNote').length,
    ).toBeGreaterThan(0);
  });

  it('always PUTs delegations with the whole policy (stored ids kept, no audit fields)', async () => {
    globalRouting((call) =>
      call.method === 'PUT'
        ? { status: 200, body: envelope({ etag: '"e2"' }) }
        : undefined,
    );
    renderPanel();

    fireEvent.change(await screen.findByLabelText('timezoneLabel'), {
      target: { value: 'Europe/Paris' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const put = putCalls()[0];
    expect(put.url).toBe('/api/limits/policy');
    expect(put.headers['If-Match']).toBe('"e1"');
    expect(put.body).toHaveProperty('delegations');
    expect((put.body as { delegations: unknown[] }).delegations).toEqual([
      {
        id: DEL_OCP,
        label: 'OCP',
        enabled: true,
        admins: ['ocp-admin@ocp.msf.org'],
        jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
        maxOverrides: 25,
      },
    ]);
    expect((put.body as { timezone: string }).timezone).toBe('Europe/Paris');
  });

  it('adds a delegation from the Delegations tab and PUTs it WITHOUT an id', async () => {
    globalRouting((call) =>
      call.method === 'PUT'
        ? { status: 200, body: envelope({ etag: '"e2"' }) }
        : undefined,
    );
    renderPanel();

    fireEvent.click(
      await screen.findByRole('tab', { name: 'tab.delegations' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'addDelegation' }));
    // New card renders expanded; name it.
    const labels = screen.getAllByLabelText('delegationLabelLabel');
    fireEvent.change(labels[labels.length - 1], {
      target: { value: 'Geneva' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const delegations = (
      putCalls()[0].body as { delegations: Array<Record<string, unknown>> }
    ).delegations;
    expect(delegations).toHaveLength(2);
    expect(delegations[0].id).toBe(DEL_OCP);
    expect(delegations[1]).not.toHaveProperty('id');
    expect(delegations[1]).toMatchObject({
      label: 'Geneva',
      enabled: true,
      maxOverrides: 25,
    });
  });

  /**
   * ADMIN_LIMITS_REVIEW #20: with scoped admins writing per-override the
   * global If-Match goes stale often; a 409 must keep the draft.
   *
   * "Keep editing" is an informed last-writer-wins, not a banner dismissal:
   * the server compares If-Match before any other check (design §5), so the
   * panel must refetch and adopt the FRESH etag while keeping the draft —
   * otherwise every later Save is a guaranteed 409 and the draft can never
   * land. The PUT mock mirrors the route: 409 unless If-Match is current.
   */
  it('Keep editing adopts the fresh etag so the kept draft can be saved', async () => {
    globalRouting((call) =>
      call.method === 'PUT'
        ? call.headers['If-Match'] === '"e2"'
          ? { status: 200, body: envelope({ etag: '"e3"' }) }
          : {
              status: 409,
              body: { error: 'conflict', code: 'LIMITS_CONFLICT' },
            }
        : undefined,
    );
    renderPanel();

    const timezone = await screen.findByLabelText('timezoneLabel');
    fireEvent.change(timezone, { target: { value: 'Europe/Paris' } });
    // Another admin saved meanwhile: the stored document is now "e2".
    stored = policyResponse({
      etag: '"e2"',
      policy: policy({ timezone: 'Africa/Nairobi' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0].headers['If-Match']).toBe('"e1"');
    // The toast must not claim anything was reloaded — nothing was.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('conflictDraftKept'),
    );
    expect(toast.error).not.toHaveBeenCalledWith('conflict');
    expect(screen.getByText('conflictKeepDraftOverwrite')).toBeInTheDocument();
    // Draft KEPT — the old behaviour refetched and discarded it.
    expect(screen.getByLabelText('timezoneLabel')).toHaveValue('Europe/Paris');
    expect(getCalls('/api/limits/policy')).toHaveLength(1);

    // Keep editing: banner goes, the policy is re-read in the background,
    // the draft survives that re-read, and the panel stays dirty.
    fireEvent.click(
      screen.getByRole('button', { name: 'conflictKeepEditing' }),
    );
    expect(
      screen.queryByText('conflictKeepDraftOverwrite'),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(getCalls('/api/limits/policy')).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'save' })).not.toBeDisabled(),
    );
    expect(screen.getByLabelText('timezoneLabel')).toHaveValue('Europe/Paris');

    // Save again: sent with the FRESH etag and accepted.
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(putCalls()).toHaveLength(2));
    expect(putCalls()[1].headers['If-Match']).toBe('"e2"');
    expect((putCalls()[1].body as { timezone: string }).timezone).toBe(
      'Europe/Paris',
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('saved'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Reload on 409 re-reads and replaces the draft with the server version', async () => {
    globalRouting((call) =>
      call.method === 'PUT'
        ? { status: 409, body: { error: 'conflict', code: 'LIMITS_CONFLICT' } }
        : undefined,
    );
    renderPanel();

    const timezone = await screen.findByLabelText('timezoneLabel');
    fireEvent.change(timezone, { target: { value: 'Europe/Paris' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(
        screen.getByText('conflictKeepDraftOverwrite'),
      ).toBeInTheDocument(),
    );

    stored = policyResponse({
      etag: '"e2"',
      policy: policy({ timezone: 'Africa/Nairobi' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'conflictReload' }));
    await waitFor(() =>
      expect(screen.getByLabelText('timezoneLabel')).toHaveValue(
        'Africa/Nairobi',
      ),
    );
    expect(
      screen.queryByText('conflictKeepDraftOverwrite'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  });

  it('lets a global admin hand an override to a saved delegation (priority forced to 0)', async () => {
    globalRouting((call) =>
      call.method === 'PUT'
        ? { status: 200, body: envelope({ etag: '"e2"' }) }
        : undefined,
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('tab', { name: 'tab.overrides' }));
    fireEvent.click(screen.getByRole('button', { name: 'expandOverride' }));
    const select = screen.getByLabelText('overrideDelegationLabel');
    expect(
      within(select).getByRole('option', { name: 'OCP' }),
    ).toBeInTheDocument();
    fireEvent.change(select, { target: { value: DEL_OCP } });

    // Now a scoped record: the priority field disappears and the tier chip shows.
    expect(screen.queryByLabelText('priorityLabel')).not.toBeInTheDocument();
    expect(screen.getByText(/tierScoped/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const saved = (putCalls()[0].body as { overrides: LimitOverride[] })
      .overrides[0];
    expect(saved.delegationId).toBe(DEL_OCP);
    expect(saved.priority).toBe(0);
    expect(saved.entries.every((e) => e.ceiling === false)).toBe(true);
  });

  it('flags a scoped override whose delegation no longer exists', async () => {
    stored = policyResponse({
      policy: policy({
        overrides: [override({ delegationId: 'del-00000000dead' })],
      }),
    });
    globalRouting();
    renderPanel();

    fireEvent.click(await screen.findByRole('tab', { name: 'tab.overrides' }));
    expect(screen.getByText('orphanedDelegationChip')).toBeInTheDocument();
  });
});
