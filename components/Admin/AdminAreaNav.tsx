'use client';

import { FC, createElement } from 'react';

import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';

import { AdminAreaId } from '@/lib/services/admin/adminAreas';

import {
  ADMIN_AREAS,
  ADMIN_GROUP_LABEL_KEY,
  ADMIN_GROUP_ORDER,
} from '@/components/Admin/areas';

import { Link } from '@/lib/navigation';

interface AdminAreaNavProps {
  areas: AdminAreaId[];
  /** `rail` is the desktop sidebar; `pills` is the horizontal mobile strip. */
  variant: 'rail' | 'pills';
}

/**
 * Navigation between admin areas.
 *
 * Selection is signalled by BACKGROUND FILL, never by a left-edge stripe —
 * DESIGN.md bans `border-left`/`border-right` accents outright, and the
 * conversation sidebar already established fill as the selection idiom.
 *
 * The active check is `startsWith`, not equality, so a nested route
 * (/admin/map-datasets/<id>) keeps its parent highlighted.
 */
export const AdminAreaNav: FC<AdminAreaNavProps> = ({ areas, variant }) => {
  const t = useTranslations();
  const pathname = usePathname();

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  if (variant === 'pills') {
    return (
      <nav
        aria-label={t('admin.areaNavLabel')}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-200 px-4 py-2 lg:hidden dark:border-gray-700"
      >
        {areas.map((id) => {
          const area = ADMIN_AREAS[id];
          const active = isActive(area.href);
          return (
            <Link
              key={id}
              href={area.href}
              aria-current={active ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                active
                  ? 'bg-gray-100 text-black dark:bg-surface-dark dark:text-white'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-black dark:text-gray-400 dark:hover:bg-surface-dark dark:hover:text-white'
              }`}
            >
              {createElement(area.icon, { size: 16 })}
              {t(area.labelKey as never)}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      aria-label={t('admin.areaNavLabel')}
      className="hidden w-56 shrink-0 overflow-y-auto border-r border-gray-200 p-3 lg:block dark:border-gray-700"
    >
      {ADMIN_GROUP_ORDER.map((group) => {
        const inGroup = areas.filter((id) => ADMIN_AREAS[id].group === group);
        if (inGroup.length === 0) return null;
        return (
          <div key={group} className="mb-4 last:mb-0">
            <h2 className="mb-1 px-2 text-xs font-semibold text-gray-500 dark:text-gray-400">
              {t(ADMIN_GROUP_LABEL_KEY[group] as never)}
            </h2>
            <ul className="space-y-0.5">
              {inGroup.map((id) => {
                const area = ADMIN_AREAS[id];
                const active = isActive(area.href);
                return (
                  <li key={id}>
                    <Link
                      href={area.href}
                      aria-current={active ? 'page' : undefined}
                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                        active
                          ? 'bg-gray-100 font-medium text-black dark:bg-surface-dark dark:text-white'
                          : 'text-gray-600 hover:bg-gray-50 hover:text-black dark:text-gray-400 dark:hover:bg-surface-dark dark:hover:text-white'
                      }`}
                    >
                      {createElement(area.icon, { size: 16 })}
                      {t(area.labelKey as never)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
};
