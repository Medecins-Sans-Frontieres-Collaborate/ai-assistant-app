'use client';

import { IconArrowLeft, IconUserShield } from '@tabler/icons-react';
import { FC, ReactNode } from 'react';

import { useTranslations } from 'next-intl';
import { useSelectedLayoutSegments } from 'next/navigation';

import { AdminAreaId } from '@/lib/services/admin/adminAreas';

import { AdminAreaNav } from '@/components/Admin/AdminAreaNav';

import { Link } from '@/lib/navigation';

interface AdminShellProps {
  areas: AdminAreaId[];
  children: ReactNode;
}

/**
 * The persistent chrome for every admin area: one back link, one title, one
 * area switcher, one scroll container.
 *
 * ⚠ WHY THE SHELL OWNS THE PAGE PLANE. `app/globals.css` paints
 * `html, body { background: #171717 }` unconditionally — in BOTH themes — and
 * ChatShell hands children a bare `flex min-w-0 flex-1` with no surface of its
 * own. Any admin page that does not sit inside a background wrapper therefore
 * renders on near-black in LIGHT mode, where `text-black` headings are
 * invisible. Every panel used to carry its own copy of that wrapper; now the
 * shell carries it once, and panels render only their body.
 *
 * FULL-BLEED PASSTHROUGH: a route two segments deep (/admin/map-datasets/<id>)
 * is a full-page editor that manages its own scrolling and header. It gets the
 * exact div ChatShell would have given it — adding padding or a second
 * `overflow-y-auto` here would break its `h-full` layout and trap its scroll.
 */
export const AdminShell: FC<AdminShellProps> = ({ areas, children }) => {
  const t = useTranslations();
  const segments = useSelectedLayoutSegments();

  if (segments.length >= 2) {
    return <div className="flex min-w-0 flex-1">{children}</div>;
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-surface-dark-base">
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-white"
        >
          <IconArrowLeft size={16} />
          {t('agentAccess.backToChat')}
        </Link>
        <span
          aria-hidden="true"
          className="h-4 w-px bg-gray-200 dark:bg-gray-700"
        />
        <IconUserShield size={20} className="text-black dark:text-white" />
        <span className="text-sm font-semibold text-black dark:text-white">
          {t('admin.title')}
        </span>
      </header>

      <AdminAreaNav areas={areas} variant="pills" />

      <div className="flex min-h-0 flex-1">
        <AdminAreaNav areas={areas} variant="rail" />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl p-6">{children}</div>
        </main>
      </div>
    </div>
  );
};
