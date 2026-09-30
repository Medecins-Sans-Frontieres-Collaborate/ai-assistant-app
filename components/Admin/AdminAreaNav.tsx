'use client';

import { FC, createElement, useMemo } from 'react';

import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';

import { AdminAreaId } from '@/lib/services/admin/adminAreas';

import { ADMIN_FIELD } from '@/components/Admin/adminClasses';
import { ADMIN_AREAS, ADMIN_GROUPS } from '@/components/Admin/areas';

import { Link, useRouter } from '@/lib/navigation';

interface AdminAreaNavProps {
  areas: AdminAreaId[];
  /** `rail` is the desktop sidebar; `picker` is the compact mobile control. */
  variant: 'rail' | 'picker';
}

/**
 * Navigation between admin areas.
 *
 * Selection is signalled by BACKGROUND FILL, never by a left-edge stripe —
 * DESIGN.md bans `border-left`/`border-right` accents outright, and the
 * conversation sidebar already established fill as the selection idiom.
 * Nesting is signalled by INDENTATION for the same reason: the items sit a
 * step further in than their group heading, with no guide rail drawn.
 *
 * The active check is `startsWith`, not equality, so a nested route
 * (/admin/map-datasets/<id>) keeps its parent highlighted. `localePrefix` is
 * `never` (config/i18n.ts), so `next/navigation`'s pathname carries no locale
 * segment and compares directly against the registry's hrefs.
 */
export const AdminAreaNav: FC<AdminAreaNavProps> = ({ areas, variant }) => {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  /**
   * The registry's groups, narrowed to what this admin may open. Groups that
   * come back empty are dropped: a local admin with no global rights should
   * not see an "Administration" heading over nothing.
   */
  const groups = useMemo(() => {
    const permitted = new Set(areas);
    return ADMIN_GROUPS.map((group) => ({
      ...group,
      areas: group.areas.filter((id) => permitted.has(id)),
    })).filter((group) => group.areas.length > 0);
  }, [areas]);

  if (variant === 'picker') {
    /**
     * One grouped select rather than the horizontal pill strip this replaced.
     * Fifteen pills in a `overflow-x-auto` row hid two thirds of the areas
     * off-screen behind a swipe and threw the group structure away entirely;
     * the native control gets the OS picker, an AAA-sized touch target, RTL
     * mirroring and screen-reader group announcement for free.
     *
     * AdminShell only renders this for one-segment routes under /admin, every
     * one of which is a registered area, so a missing match is a bug rather
     * than a state — but it still gets a placeholder instead of silently
     * displaying the first option as if it were the current page.
     */
    const activeArea = areas.find((id) => isActive(ADMIN_AREAS[id].href));
    const activeIcon = activeArea ? ADMIN_AREAS[activeArea].icon : null;

    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-4 py-2 lg:hidden dark:border-gray-700">
        {activeIcon &&
          createElement(activeIcon, {
            size: 18,
            className: 'shrink-0 text-black dark:text-white',
          })}
        <select
          className={`${ADMIN_FIELD} min-h-11 min-w-0 flex-1`}
          value={activeArea ?? ''}
          aria-label={t('admin.areaNavLabel')}
          onChange={(event) =>
            router.push(ADMIN_AREAS[event.target.value as AdminAreaId].href)
          }
        >
          {activeArea === undefined && (
            <option value="" disabled>
              {t('admin.areaNavLabel')}
            </option>
          )}
          {groups.map((group) => (
            <optgroup key={group.id} label={t(group.labelKey as never)}>
              {group.areas.map((id) => (
                <option key={id} value={id}>
                  {t(ADMIN_AREAS[id].labelKey as never)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    );
  }

  return (
    <nav
      aria-label={t('admin.areaNavLabel')}
      className="hidden w-56 shrink-0 overflow-y-auto border-r border-gray-200 p-3 lg:block dark:border-gray-700"
    >
      {groups.map((group) => (
        <div key={group.id} className="mb-4 last:mb-0">
          {/*
            Sticky so the heading survives a scroll on a short window, which is
            the only time this rail scrolls at all. It needs its own background
            for that: AdminShell paints the plane, not the nav.
          */}
          <h2 className="sticky top-0 z-10 mb-1 bg-white px-2 pb-1 text-xs font-semibold text-gray-500 dark:bg-surface-dark-base dark:text-gray-400">
            {t(group.labelKey as never)}
          </h2>
          <ul className="space-y-0.5">
            {group.areas.map((id) => {
              const area = ADMIN_AREAS[id];
              const active = isActive(area.href);
              return (
                <li key={id}>
                  <Link
                    href={area.href}
                    aria-current={active ? 'page' : undefined}
                    title={t(area.descriptionKey as never)}
                    // `ps`/`pe` rather than `px`: the indent has to move to the
                    // right edge under RTL, where a hard-coded left padding
                    // would leave the nesting reading backwards.
                    className={`flex items-center gap-2 rounded-lg py-1.5 pe-2 ps-4 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                      active
                        ? 'bg-gray-100 font-medium text-black dark:bg-surface-dark dark:text-white'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-black dark:text-gray-400 dark:hover:bg-surface-dark dark:hover:text-white'
                    }`}
                  >
                    {createElement(area.icon, {
                      size: 16,
                      className: 'shrink-0',
                    })}
                    {t(area.labelKey as never)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
};
