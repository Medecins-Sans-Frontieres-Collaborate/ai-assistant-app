'use client';

import { IconExternalLink } from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { AdminTabs } from '@/components/Admin/AdminTabs';
import { FieldPolicyTab } from '@/components/Admin/Analytics/FieldPolicyTab';
import { FoldersTab } from '@/components/Admin/Analytics/FoldersTab';
import { HealthTab } from '@/components/Admin/Analytics/HealthTab';
import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_SECONDARY,
} from '@/components/Admin/adminClasses';

import { Link } from '@/lib/navigation';

type TabId = 'health' | 'folders' | 'fields';
const TAB_IDS: TabId[] = ['health', 'folders', 'fields'];
const ID_PREFIX = 'analytics-admin';

/**
 * Analytics admin (docs/ANALYTICS_ADMIN_ASSESSMENT.md): what the ETL
 * delivered and what is wrong with it, who may open each folder, and which
 * fields the platform may show.
 *
 * Health comes first on purpose. The files arrive from a pipeline the app
 * does not run, so "is what arrived usable" is the question an admin opens
 * this page with; folders and fields are set up once and revisited rarely.
 *
 * The page's server component gates access; every route re-checks it.
 */
export const AnalyticsAdminPanel: FC = () => {
  const t = useTranslations('analyticsAdmin');
  const [tab, setTab] = useState<TabId>('health');

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-black dark:text-white">
            {t('title')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            {t('description')}
          </p>
        </div>
        <Link href="/analytics" className={ADMIN_BTN_SECONDARY}>
          <IconExternalLink size={16} aria-hidden="true" />
          {t('openViewer')}
        </Link>
      </header>

      <p className={ADMIN_BANNER_WARN} role="note">
        {t('sharedNotice')}
      </p>

      <AdminTabs
        tabs={TAB_IDS.map((id) => ({ id, label: t(`tab.${id}`) }))}
        activeTab={tab}
        onChange={(id) => setTab(id as TabId)}
        idPrefix={ID_PREFIX}
        ariaLabel={t('tabsLabel')}
      />

      <div
        role="tabpanel"
        id={`${ID_PREFIX}-panel-${tab}`}
        aria-labelledby={`${ID_PREFIX}-tab-${tab}`}
      >
        {tab === 'health' && (
          <HealthTab onOpenFields={() => setTab('fields')} />
        )}
        {tab === 'folders' && <FoldersTab />}
        {tab === 'fields' && <FieldPolicyTab />}
      </div>
    </div>
  );
};
