'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useAnalyticsDashboard } from '@/client/hooks/analytics/useAnalytics';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BTN_RETRY,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { EmissionsDashboard } from '@/components/Analytics/dashboards/EmissionsDashboard';
import { RebillingDashboard } from '@/components/Analytics/dashboards/RebillingDashboard';
import { TelemetryDashboard } from '@/components/Analytics/dashboards/TelemetryDashboard';
import { UsageDashboard } from '@/components/Analytics/dashboards/UsageDashboard';

interface DashboardViewProps {
  fileId: string;
}

/**
 * A file's overview: headline figures and charts for its report type, drawn
 * from aggregates the server computed and filtered for this person.
 */
export const DashboardView: FC<DashboardViewProps> = ({ fileId }) => {
  const t = useTranslations('analytics.dash');
  const dashboard = useAnalyticsDashboard(fileId, true);

  if (dashboard.isLoading) return <p className={ADMIN_MUTED}>{t('loading')}</p>;
  if (dashboard.isError || !dashboard.data) {
    return (
      <div className={ADMIN_BANNER_ERROR} role="alert">
        <p>{t('failed')}</p>
        <button
          type="button"
          className={`${ADMIN_BTN_RETRY} mt-2`}
          onClick={() => dashboard.refetch()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  const view = dashboard.data;
  switch (view.reportType) {
    case 'usage':
      return <UsageDashboard view={view} />;
    case 'rebilling':
      return <RebillingDashboard view={view} />;
    case 'emissions':
      return <EmissionsDashboard view={view} />;
    case 'raw-telemetry':
      return <TelemetryDashboard view={view} />;
  }
};
