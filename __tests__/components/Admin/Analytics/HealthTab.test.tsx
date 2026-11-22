import { render, screen } from '@testing-library/react';

import { AnalyticsHealthResponse } from '@/lib/services/analytics/dto';

import { HealthTab } from '@/components/Admin/Analytics/HealthTab';

import { describe, expect, it, vi } from 'vitest';

/**
 * The Deliveries tab must not call an app-made, still-empty delivery
 * container "all good": that state usually means the ETL is not writing.
 */

const healthState = vi.hoisted(() => ({
  data: null as AnalyticsHealthResponse | null,
}));

// A stable `t`: a new function per render loops effects keyed on it.
const translate = (key: string) => key;
vi.mock('next-intl', () => ({
  useTranslations: () => translate,
  useLocale: () => 'en',
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/client/hooks/settings/useAnalyticsAdmin', () => ({
  useAnalyticsHealthAdmin: () => ({
    query: {
      isLoading: false,
      isError: false,
      data: healthState.data,
      refetch: vi.fn(),
    },
    recheck: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

function health(
  overrides: Partial<AnalyticsHealthResponse> = {},
): AnalyticsHealthResponse {
  return {
    deliveryUnavailable: false,
    foldersUnavailable: false,
    policyUnavailable: false,
    deliveryContainerCreatedByApp: false,
    container: 'ai-portal-analytics',
    retentionDeletion: 'active',
    graceDays: 7,
    totals: { files: 0, ok: 0, warning: 0, error: 0, pending: 0 },
    problems: [],
    unconfiguredFolders: [],
    staleFolders: [],
    unclassifiedColumns: [],
    expiring: [],
    ...overrides,
  };
}

describe('HealthTab delivery container banner', () => {
  it('warns instead of reporting all good when the app made the container', () => {
    healthState.data = health({ deliveryContainerCreatedByApp: true });
    render(<HealthTab onOpenFields={vi.fn()} />);
    expect(
      screen.getByText('health.deliveryContainerCreatedTitle'),
    ).toBeInTheDocument();
    expect(screen.queryByText('health.allGood')).not.toBeInTheDocument();
  });

  it('shows no warning for a container the infrastructure made', () => {
    healthState.data = health();
    render(<HealthTab onOpenFields={vi.fn()} />);
    expect(
      screen.queryByText('health.deliveryContainerCreatedTitle'),
    ).not.toBeInTheDocument();
  });
});
