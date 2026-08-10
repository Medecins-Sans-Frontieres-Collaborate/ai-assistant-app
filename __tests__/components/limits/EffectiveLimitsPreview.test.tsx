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
  useEffectiveLimitsPreview: (mail: string | null) => mockPreview(mail),
}));

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

function renderAndCheck(props: { dirty?: boolean } = {}) {
  render(
    <EffectiveLimitsPreview
      overrides={[CONTRACTORS]}
      dirty={props.dirty ?? false}
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
    expect(mockPreview).toHaveBeenLastCalledWith(null);
  });

  it('normalizes the email and names the winning override by label', () => {
    mockPreview.mockReturnValue(okResult());
    renderAndCheck();

    expect(mockPreview).toHaveBeenLastCalledWith('user@example.org');
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
});
