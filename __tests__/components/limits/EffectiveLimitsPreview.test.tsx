import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { MyLimitsResponse } from '@/client/hooks/settings/useLimitsAdmin';

import { LimitOverride } from '@/lib/services/limits/types';

import { OpenAIModel } from '@/types/openai';

import { EffectiveLimitsPreview } from '@/components/Limits/EffectiveLimitsPreview';
import { LimitsCostProvider } from '@/components/Limits/LimitsCostContext';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Key echo; a `label` or `amount` value is appended as `key:value`. */
vi.mock('next-intl', () => ({
  useTranslations:
    () => (key: string, params?: Record<string, string | number>) =>
      params && 'label' in params
        ? `${key}:${params.label}`
        : params && 'amount' in params
          ? `${key}:${params.amount}`
          : key,
  useLocale: () => 'en',
}));

/** Flags default to none — the OFF path every pre-existing case runs on. */
const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const mockPreview = vi.fn();
vi.mock('@/client/hooks/settings/useLimitsAdmin', async (importOriginal) => ({
  // The real module otherwise (the cost provider reads its flag hooks).
  ...(await importOriginal<
    typeof import('@/client/hooks/settings/useLimitsAdmin')
  >()),
  useEffectiveLimitsPreview: (
    mail: string | null,
    options?: { usage?: boolean },
  ) => mockPreview(mail, options),
}));

/** The mail the hook was last asked about (its first argument). */
const lastMail = () => mockPreview.mock.lastCall?.[0];
const lastOptions = () => mockPreview.mock.lastCall?.[1];

const CONTRACTORS: LimitOverride = {
  id: 'lim-0123456789ab',
  label: 'Contractors',
  enabled: true,
  scope: 'domain',
  targets: ['example.org'],
  priority: 0,
  entries: [],
  createdBy: 'a@example.org',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'a@example.org',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function okResult(partial: Partial<MyLimitsResponse> = {}) {
  return {
    result: {
      enabled: true,
      preview: true,
      subject: 'user@example.org',
      mode: 'enforce',
      limits: [
        {
          limitKey: 'feature.codeInterpreter.runsPerDay',
          value: 50,
          unit: 'runs',
          window: 'day',
          source: 'domain',
          overrideId: 'lim-0123456789ab',
        },
        {
          limitKey: 'feature.webSearch.enabled',
          value: false,
          unit: 'boolean',
          window: 'none',
          source: 'global',
        },
      ],
      notEvaluated: ['attribute', 'group'],
      ...partial,
    },
    forbidden: false,
    isLoading: false,
    error: null,
  };
}

function renderAndCheck(
  props: {
    dirty?: boolean;
    scoped?: boolean;
    scopeNote?: string;
  } = {},
) {
  render(
    <EffectiveLimitsPreview
      overrides={[CONTRACTORS]}
      dirty={props.dirty ?? false}
      scoped={props.scoped}
      scopeNote={props.scopeNote}
    />,
  );
  fireEvent.change(screen.getByLabelText('previewEmailLabel'), {
    target: { value: 'User@Example.org' },
  });
  fireEvent.click(screen.getByRole('button', { name: /previewRun/ }));
}

describe('EffectiveLimitsPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreview.mockReturnValue({
      result: null,
      forbidden: false,
      isLoading: false,
      error: null,
    });
  });

  it('shows no results before an email is checked', () => {
    render(<EffectiveLimitsPreview overrides={[]} dirty={false} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // No email typed → the query stays disabled.
    expect(lastMail()).toBe(null);
  });

  it('normalizes the email and names the winning override by label', () => {
    mockPreview.mockReturnValue(okResult());
    renderAndCheck();

    expect(lastMail()).toBe('user@example.org');
    // overrideId mapped to the override's human label.
    expect(
      screen.getByText('previewSourceOverride:Contractors'),
    ).toBeInTheDocument();
    // Global-default provenance for the other row.
    expect(screen.getByText('previewSourceGlobal')).toBeInTheDocument();
    // Values rendered with the shared vocabulary.
    expect(screen.getByText('modeBlocked')).toBeInTheDocument();
    expect(screen.getByText('50 unit.runs / window.day')).toBeInTheDocument();
  });

  it('falls back to the raw override id when no draft override matches', () => {
    mockPreview.mockReturnValue(okResult());
    render(<EffectiveLimitsPreview overrides={[]} dirty={false} />);
    fireEvent.change(screen.getByLabelText('previewEmailLabel'), {
      target: { value: 'user@example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /previewRun/ }));

    expect(
      screen.getByText('previewSourceOverride:lim-0123456789ab'),
    ).toBeInTheDocument();
  });

  it('always states the not-evaluated layers with results', () => {
    mockPreview.mockReturnValue(okResult());
    renderAndCheck();
    expect(screen.getByText('previewNotEvaluated')).toBeInTheDocument();
  });

  it('warns that the preview reflects the saved policy when the draft is dirty', () => {
    mockPreview.mockReturnValue(okResult());
    renderAndCheck({ dirty: true });
    expect(screen.getByText('previewUnsaved')).toBeInTheDocument();
  });

  it('does not warn when the draft is clean', () => {
    mockPreview.mockReturnValue(okResult());
    renderAndCheck();
    expect(screen.queryByText('previewUnsaved')).not.toBeInTheDocument();
  });

  it('renders the forbidden notice on a 403', () => {
    mockPreview.mockReturnValue({
      result: null,
      forbidden: true,
      isLoading: false,
      error: null,
    });
    renderAndCheck();
    expect(screen.getByText('previewForbidden')).toBeInTheDocument();
  });

  /**
   * Contract (design §6c): a scoped admin's 403 is three-valued on the wire
   * — `LIMITS_PREVIEW_OUT_OF_SCOPE` with `details: 'outside'` (provably
   * outside), the same code with `details: 'undecidable'` (a group/attribute
   * predicate means the person MAY be inside), or a plain `FORBIDDEN` (no
   * longer a scoped admin). Each gets its own sentence; "outside your scope"
   * is a false statement for the other two, and the global "only global
   * admins" line is false for all three.
   */
  describe('scoped 403 wording (design §6c)', () => {
    const forbidden = (forbiddenCode?: string, forbiddenDetails?: string) => {
      mockPreview.mockReturnValue({
        result: null,
        forbidden: true,
        forbiddenCode,
        forbiddenDetails,
        isLoading: false,
        error: null,
      });
    };

    it("says 'outside your scope' only for the server's outside verdict", () => {
      forbidden('LIMITS_PREVIEW_OUT_OF_SCOPE', 'outside');
      renderAndCheck({ scoped: true });
      expect(screen.getByText('previewOutOfScope')).toBeInTheDocument();
      expect(screen.queryByText('previewForbidden')).not.toBeInTheDocument();
      expect(
        screen.queryByText('previewUndecidableScope'),
      ).not.toBeInTheDocument();
    });

    it("says 'cannot be decided by mail' for the undecidable verdict, never 'outside'", () => {
      forbidden('LIMITS_PREVIEW_OUT_OF_SCOPE', 'undecidable');
      renderAndCheck({ scoped: true });
      expect(screen.getByText('previewUndecidableScope')).toBeInTheDocument();
      expect(screen.queryByText('previewOutOfScope')).not.toBeInTheDocument();
      expect(screen.queryByText('previewForbidden')).not.toBeInTheDocument();
    });

    it("says 'no longer an admin' for a plain FORBIDDEN in scoped mode", () => {
      forbidden('FORBIDDEN');
      renderAndCheck({ scoped: true });
      expect(screen.getByText('previewNoLongerAdmin')).toBeInTheDocument();
      expect(screen.queryByText('previewOutOfScope')).not.toBeInTheDocument();
      expect(screen.queryByText('previewForbidden')).not.toBeInTheDocument();
    });

    it('keeps the global-admin sentence for a plain FORBIDDEN outside scoped mode', () => {
      forbidden('FORBIDDEN');
      renderAndCheck();
      expect(screen.getByText('previewForbidden')).toBeInTheDocument();
      expect(
        screen.queryByText('previewNoLongerAdmin'),
      ).not.toBeInTheDocument();
    });
  });

  it('renders the scope note under the description', () => {
    render(
      <EffectiveLimitsPreview
        overrides={[]}
        dirty={false}
        scopeNote="previewGroupOnlyScope"
      />,
    );
    expect(screen.getByText('previewGroupOnlyScope')).toBeInTheDocument();
  });

  describe('tier and ceiling provenance (design §6c)', () => {
    it('marks a scoped winner and names the pinning override by label', () => {
      mockPreview.mockReturnValue(
        okResult({
          limits: [
            {
              limitKey: 'feature.codeInterpreter.runsPerDay',
              value: 50,
              unit: 'runs',
              window: 'day',
              source: 'user',
              tier: 'scoped',
              overrideId: 'lim-00000000cafe',
              ceilingApplied: true,
              ceilingOverrideId: 'lim-0123456789ab',
            },
          ],
        }),
      );
      renderAndCheck();
      expect(screen.getByText('tierScoped')).toBeInTheDocument();
      expect(
        screen.getByText('previewCeilingPinned:Contractors'),
      ).toBeInTheDocument();
    });

    it('prefers the server-supplied ceiling label and falls back to the global default', () => {
      mockPreview.mockReturnValue(
        okResult({
          limits: [
            {
              limitKey: 'chat.messagesPerDay',
              value: 100,
              unit: 'requests',
              window: 'day',
              source: 'user',
              tier: 'scoped',
              overrideId: 'lim-00000000cafe',
              ceilingApplied: true,
              ceilingOverrideId: 'lim-00000000beef',
              ceilingLabel: 'OCP hard cap',
            },
            {
              limitKey: 'chat.tokensPerDay',
              value: 1000,
              unit: 'tokens',
              window: 'day',
              source: 'domain',
              overrideId: 'lim-0123456789ab',
              ceilingApplied: true,
            },
          ],
        }),
      );
      renderAndCheck();
      expect(
        screen.getByText('previewCeilingPinned:OCP hard cap'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('previewCeilingPinned:previewSourceGlobal'),
      ).toBeInTheDocument();
    });

    it('does not mention a ceiling when none applied', () => {
      mockPreview.mockReturnValue(okResult());
      renderAndCheck();
      expect(
        screen.queryByText(/previewCeilingPinned/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('tierScoped')).not.toBeInTheDocument();
    });
  });

  describe('usage (design §6c)', () => {
    it('asks for usage only when the toggle is on', () => {
      mockPreview.mockReturnValue(okResult());
      renderAndCheck();
      expect(lastOptions()).toEqual({ usage: false });
      fireEvent.click(screen.getByLabelText('previewShowUsage'));
      expect(lastOptions()).toEqual({ usage: true });
      // Off again → no usage column even if the server sent counters.
      fireEvent.click(screen.getByLabelText('previewShowUsage'));
      expect(screen.queryByText('previewColumnUsage')).not.toBeInTheDocument();
    });

    it('renders a proportion bar per counted limit', () => {
      mockPreview.mockReturnValue(
        okResult({
          usage: {
            'feature.codeInterpreter.runsPerDay': { used: 25, window: 'day' },
          },
        }),
      );
      renderAndCheck();
      fireEvent.click(screen.getByLabelText('previewShowUsage'));
      expect(screen.getByText('previewColumnUsage')).toBeInTheDocument();
      expect(screen.getByText('previewUsageOf')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '50',
      );
    });

    it("reads per-model usage under the debit path's model:<id>.<suffix> key", () => {
      mockPreview.mockReturnValue(
        okResult({
          limits: [
            {
              limitKey: 'model.requests',
              modelId: 'gpt-5.2',
              value: 100,
              unit: 'requests',
              window: 'day',
              source: 'global',
            },
          ],
          usage: { 'model:gpt-5.2.requests': { used: 30, window: 'day' } },
        }),
      );
      renderAndCheck();
      fireEvent.click(screen.getByLabelText('previewShowUsage'));
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '30',
      );
    });

    it('says usage is unavailable rather than failing the preview', () => {
      mockPreview.mockReturnValue(okResult({ usageUnavailable: true }));
      renderAndCheck();
      fireEvent.click(screen.getByLabelText('previewShowUsage'));
      expect(screen.getByText('previewUsageUnavailable')).toBeInTheDocument();
      expect(screen.queryByText('previewColumnUsage')).not.toBeInTheDocument();
      // Results still render.
      expect(screen.getByRole('table')).toBeInTheDocument();
    });
  });
});

/**
 * Spend card (docs/LIMITS_COST_INSIGHTS_DESIGN.md §4b): rendered under the
 * table only with `limitsCostInsights` on. The per-day ceiling is the MIN
 * over the conjunctive axes (never a sum) at the priciest allowed model,
 * with ≈ per month at 30.4375 days; "no spend ceiling" when nothing binds;
 * "no spend possible" when every priced model is blocked; and, only with
 * the usage toggle on, "spent so far" from the counted cells — a floor,
 * not a bill, with its basis named — or "not metered" when no counted
 * cell prices. The disclosure line is always present on the card.
 */
describe('EffectiveLimitsPreview — cost insights', () => {
  const fixture = (id: string, inputPer1M: number, outputPer1M: number) =>
    ({
      id,
      name: `Model ${id}`,
      maxLength: 0,
      tokenLimit: 0,
      isDisabled: false,
      pricing: { inputPer1M, outputPer1M },
    }) as OpenAIModel;
  /** $0.02 and $0.20 per typical request. */
  const DEAR = fixture('test-dear', 10, 20);
  const OTHER = fixture('test-other', 100, 200);

  const MESSAGES_10: MyLimitsResponse['limits'] = [
    {
      limitKey: 'chat.messagesPerDay',
      value: 10,
      unit: 'requests',
      window: 'day',
      source: 'global',
    },
    {
      limitKey: 'feature.webSearch.enabled',
      value: true,
      unit: 'boolean',
      window: 'none',
      source: 'global',
    },
  ];

  function renderWithCost() {
    render(
      <LimitsCostProvider>
        <EffectiveLimitsPreview overrides={[CONTRACTORS]} dirty={false} />
      </LimitsCostProvider>,
    );
    fireEvent.change(screen.getByLabelText('previewEmailLabel'), {
      target: { value: 'user@example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /previewRun/ }));
  }

  const card = () => screen.queryByTestId('limits-cost-card');

  beforeEach(() => {
    delete mockFlags.limitsCostInsights;
    useSettingsStore.setState({ models: [DEAR, OTHER] });
  });

  it('renders no card when the flag is undefined', () => {
    mockPreview.mockReturnValue(okResult({ limits: MESSAGES_10 }));
    renderWithCost();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(card()).not.toBeInTheDocument();
    expect(screen.queryByText(/^cost\./)).not.toBeInTheDocument();
  });

  it('shows the per-day and ≈ per-month ceiling on the binding axis', () => {
    mockFlags.limitsCostInsights = true;
    mockPreview.mockReturnValue(okResult({ limits: MESSAGES_10 }));
    renderWithCost();
    // 10 messages × $0.20 (priciest allowed) = $2.00; × 30.4375 = $60.875 → $60.88.
    expect(card()).toHaveTextContent('cost.ceilingTitle');
    expect(card()).toHaveTextContent('cost.ceilingPerDay:$2.00');
    expect(card()).toHaveTextContent('cost.ceilingPerMonth:$60.88');
    expect(card()).toHaveTextContent('cost.ceilingAxisLabel');
    expect(card()).toHaveTextContent('cost.ceilingPriciest');
    expect(card()).toHaveTextContent('cost.disclosure');
    // No usage toggle → no spent line at all.
    expect(card()).not.toHaveTextContent('cost.spent');
  });

  it('takes the MIN over conjunctive axes, never the sum', () => {
    mockFlags.limitsCostInsights = true;
    mockPreview.mockReturnValue(
      okResult({
        limits: [
          ...MESSAGES_10,
          // Tokens: 1,500 tokens/day = one typical request at OTHER = $0.20.
          {
            limitKey: 'chat.tokensPerDay',
            value: 1500,
            unit: 'tokens',
            window: 'day',
            source: 'global',
          },
        ],
      }),
    );
    renderWithCost();
    expect(card()).toHaveTextContent('cost.ceilingPerDay:$0.20');
    expect(card()).not.toHaveTextContent('$2.20');
  });

  it('says "no spend ceiling" when nothing binds', () => {
    mockFlags.limitsCostInsights = true;
    mockPreview.mockReturnValue(
      okResult({
        limits: [
          {
            limitKey: 'chat.messagesPerDay',
            value: null,
            unit: 'requests',
            window: 'day',
            source: 'catalog',
          },
        ],
      }),
    );
    renderWithCost();
    expect(card()).toHaveTextContent('cost.ceilingUnbounded');
    expect(card()).not.toHaveTextContent('cost.ceilingPerDay');
  });

  it('says "no spend possible" — not $0.00 — when every priced model is blocked', () => {
    mockFlags.limitsCostInsights = true;
    mockPreview.mockReturnValue(
      okResult({
        limits: [
          ...MESSAGES_10,
          {
            limitKey: 'model.allowed',
            value: false,
            unit: 'boolean',
            window: 'none',
            source: 'global',
          },
        ],
      }),
    );
    renderWithCost();
    expect(card()).toHaveTextContent('cost.ceilingBlocked');
    expect(card()).not.toHaveTextContent('$0.00');
  });

  it('shows "spent so far" with its basis only when the usage toggle is on', () => {
    mockFlags.limitsCostInsights = true;
    mockPreview.mockReturnValue(
      okResult({
        limits: MESSAGES_10,
        usage: { 'chat.messagesPerDay': { used: 3, window: 'day' } },
      }),
    );
    renderWithCost();
    expect(card()).not.toHaveTextContent('cost.spentSoFar');
    fireEvent.click(screen.getByLabelText('previewShowUsage'));
    // 3 counted messages × $0.20 = $0.60, from the messages counter.
    expect(card()).toHaveTextContent('cost.spentSoFar:$0.60');
    expect(card()).toHaveTextContent('cost.spentBasis.messages');
    expect(card()).not.toHaveTextContent('cost.spentNotMetered');
  });

  it('prefers per-model request counters and lists unpriced ones', () => {
    mockFlags.limitsCostInsights = true;
    mockPreview.mockReturnValue(
      okResult({
        limits: MESSAGES_10,
        usage: {
          'chat.messagesPerDay': { used: 3, window: 'day' },
          'model:test-dear.requests': { used: 5, window: 'day' },
          'model:byom-x.requests': { used: 9, window: 'day' },
        },
      }),
    );
    renderWithCost();
    fireEvent.click(screen.getByLabelText('previewShowUsage'));
    // 5 × $0.02 = $0.10; the byom counter is listed, never priced.
    expect(card()).toHaveTextContent('cost.spentSoFar:$0.10');
    expect(card()).toHaveTextContent('cost.spentBasis.models');
    expect(card()).toHaveTextContent('cost.spentUnpriced');
  });

  it('says "not metered" when no counted cell prices, keeping the table dashes', () => {
    mockFlags.limitsCostInsights = true;
    mockPreview.mockReturnValue(
      okResult({
        limits: MESSAGES_10,
        usage: {
          'feature.codeInterpreter.runsPerDay': { used: 25, window: 'day' },
        },
      }),
    );
    renderWithCost();
    fireEvent.click(screen.getByLabelText('previewShowUsage'));
    expect(card()).toHaveTextContent('cost.spentNotMetered');
    expect(card()).not.toHaveTextContent('cost.spentSoFar');
    // The unmetered messages row still shows the table's dash.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows no spent line when the server could not read counters', () => {
    mockFlags.limitsCostInsights = true;
    mockPreview.mockReturnValue(
      okResult({ limits: MESSAGES_10, usageUnavailable: true }),
    );
    renderWithCost();
    fireEvent.click(screen.getByLabelText('previewShowUsage'));
    expect(screen.getByText('previewUsageUnavailable')).toBeInTheDocument();
    expect(card()).toHaveTextContent('cost.ceilingPerDay:$2.00');
    expect(card()).not.toHaveTextContent('cost.spent');
  });
});
