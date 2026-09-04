import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { MyLimitsResponse } from '@/client/hooks/settings/useLimitsAdmin';

import { LimitOverride } from '@/lib/services/limits/types';

import { EffectiveLimitsPreview } from '@/components/Limits/EffectiveLimitsPreview';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations:
    () => (key: string, params?: Record<string, string | number>) =>
      params && 'label' in params ? `${key}:${params.label}` : key,
}));

const mockPreview = vi.fn();
vi.mock('@/client/hooks/settings/useLimitsAdmin', () => ({
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
    forbiddenMessage?: string;
    scopeNote?: string;
  } = {},
) {
  render(
    <EffectiveLimitsPreview
      overrides={[CONTRACTORS]}
      dirty={props.dirty ?? false}
      forbiddenMessage={props.forbiddenMessage}
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

  it('uses the caller-supplied forbidden copy (scoped admin: outside your scope)', () => {
    mockPreview.mockReturnValue({
      result: null,
      forbidden: true,
      forbiddenCode: 'LIMITS_PREVIEW_OUT_OF_SCOPE',
      isLoading: false,
      error: null,
    });
    renderAndCheck({ forbiddenMessage: 'previewOutOfScope' });
    expect(screen.getByText('previewOutOfScope')).toBeInTheDocument();
    expect(screen.queryByText('previewForbidden')).not.toBeInTheDocument();
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
