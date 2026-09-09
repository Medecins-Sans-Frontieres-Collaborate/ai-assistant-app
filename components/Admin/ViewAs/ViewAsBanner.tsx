'use client';

import { IconMasksTheater } from '@tabler/icons-react';
import { useSession } from 'next-auth/react';

import { useTranslations } from 'next-intl';

import { useViewAs } from '@/client/hooks/settings/useViewAs';

import { ViewAsOverrides } from '@/lib/services/admin/viewAsTypes';

import { Link } from '@/lib/navigation';

/**
 * Persistent banner while an admin's "view as" test mode is active.
 *
 * Reads the session (the server already applied the overrides and attached
 * `viewAs`), so it needs no cookie access — and unlike the region banner it
 * cannot be triggered by anyone who is not a global admin, because the
 * server never attaches `viewAs` for anyone else. "Exit" always works: the
 * clear route is gated on the REAL identity.
 */
export function ViewAsBanner() {
  const t = useTranslations('viewAs.banner');
  const { data: session } = useSession();
  const { clear } = useViewAs();

  const viewAs = session?.user?.viewAs;
  if (!viewAs) return null;

  const parts = describe(viewAs.overrides, t);

  return (
    <div
      role="status"
      className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-purple-500 bg-purple-100 px-4 py-2 text-center text-sm font-medium text-purple-900 dark:border-purple-500/60 dark:bg-purple-950/60 dark:text-purple-200"
    >
      <IconMasksTheater size={16} aria-hidden />
      <span>
        {t('label')}: {parts.join(' · ')}
      </span>
      <Link
        href="/admin/view-as"
        className="rounded-md border border-purple-500 px-2 py-0.5 text-xs font-semibold hover:bg-purple-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-purple-500/60 dark:hover:bg-purple-900/60"
      >
        {t('adjust')}
      </Link>
      <button
        type="button"
        disabled={clear.isPending}
        onClick={() => clear.mutate()}
        className="rounded-md border border-purple-500 px-2 py-0.5 text-xs font-semibold hover:bg-purple-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:border-purple-500/60 dark:hover:bg-purple-900/60"
      >
        {t('exit')}
      </button>
    </div>
  );
}

function describe(
  overrides: ViewAsOverrides,
  t: ReturnType<typeof useTranslations<'viewAs.banner'>>,
): string[] {
  const parts: string[] = [];
  if (overrides.adminRole === 'local' || overrides.adminRole === 'none') {
    parts.push(t(`role.${overrides.adminRole}`));
  }
  if (overrides.region) parts.push(t('region', { region: overrides.region }));
  for (const key of [
    'department',
    'companyName',
    'jobTitle',
    'officeId',
  ] as const) {
    const value = overrides[key];
    if (value) parts.push(t(key, { value }));
  }
  if (overrides.groupIds?.length) {
    parts.push(t('groups', { count: overrides.groupIds.length }));
  }
  if (overrides.limitDelegationIds?.length) {
    parts.push(
      t('limitDelegations', { count: overrides.limitDelegationIds.length }),
    );
  }
  return parts;
}
