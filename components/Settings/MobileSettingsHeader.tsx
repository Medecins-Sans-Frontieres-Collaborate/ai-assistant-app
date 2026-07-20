import { IconMenu2, IconRefresh, IconX } from '@tabler/icons-react';
import { FC, createElement, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from 'next-intl';

import { SettingsSection } from './types';
import { useSettingsNav } from './useSettingsNav';

import { Link } from '@/lib/navigation';

interface MobileSettingsHeaderProps {
  activeSection: SettingsSection;
  setActiveSection: (section: SettingsSection) => void;
  handleReset: () => void;
  onClose: () => void;
}

/**
 * Mobile counterpart to SettingsSidebar: a sticky title bar whose menu button
 * opens a bottom sheet listing every section.
 *
 * The list comes from `useSettingsNav` rather than a local copy — the previous
 * hardcoded array had drifted badly from the desktop sidebar, silently hiding
 * Usage & Impact, Backup, Memories, Local Models, Agent Access and Reset from
 * every phone user.
 *
 * A bottom sheet rather than the old top-anchored dropdown, matching the
 * workflow switcher: it also drops that panel's `top-[65px]` magic number and
 * `max-h-[60vh]` (which, like every `vh` on mobile, measured the large
 * viewport and so could extend under the browser chrome).
 */
export const MobileSettingsHeader: FC<MobileSettingsHeaderProps> = ({
  activeSection,
  setActiveSection,
  handleReset,
  onClose,
}) => {
  const t = useTranslations();
  const navItems = useSettingsNav();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);

  useEffect(() => {
    if (!isMenuOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isMenuOpen]);

  const activeItem = navItems.find(
    (item) => item.kind === 'section' && item.section === activeSection,
  );

  const handleConfirmReset = () => {
    handleReset();
    setShowResetConfirmation(false);
    onClose();
  };

  return (
    <>
      <div className="sticky top-0 bg-white dark:bg-surface-dark-base p-4 border-b border-gray-300 dark:border-gray-700 z-20 rounded-t-lg">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">
            {activeItem?.label ?? t('settings.Settings')}
          </h2>
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-black dark:text-white"
            aria-label={t('common.toggleMenu')}
          >
            {isMenuOpen ? <IconX size={20} /> : <IconMenu2 size={20} />}
          </button>
        </div>
      </div>

      {isMenuOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[10000] bg-black/40 backdrop-blur-sm animate-fade-in-fast"
              aria-hidden="true"
              onClick={() => setIsMenuOpen(false)}
            />
            <div
              role="menu"
              aria-label={t('settings.Settings')}
              className="fixed inset-x-0 bottom-0 z-[10001] flex max-h-[75dvh] flex-col overflow-y-auto rounded-t-2xl border-t border-gray-200 bg-white shadow-lg outline-none animate-slide-up pb-[env(safe-area-inset-bottom)] dark:border-gray-700 dark:bg-surface-dark-base"
            >
              <div className="p-2">
                {navItems.map((item) =>
                  item.kind === 'link' ? (
                    <Link
                      key={item.href}
                      href={item.href}
                      role="menuitem"
                      onClick={() => {
                        setIsMenuOpen(false);
                        onClose();
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-start text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      {createElement(item.icon, { size: 20 })}
                      <span className="text-sm font-medium">{item.label}</span>
                    </Link>
                  ) : (
                    <button
                      key={item.section}
                      type="button"
                      role="menuitemradio"
                      aria-checked={item.section === activeSection}
                      onClick={() => {
                        setActiveSection(item.section);
                        setIsMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-3 rounded-lg px-4 py-3 text-start transition-colors ${
                        item.section === activeSection
                          ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400'
                          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                      }`}
                    >
                      {createElement(item.icon, { size: 20 })}
                      <span className="text-sm font-medium">{item.label}</span>
                    </button>
                  ),
                )}
              </div>

              {/* Reset lives at the bottom behind a divider, mirroring the
                  desktop sidebar — it was unreachable on mobile entirely. */}
              <div className="border-t border-gray-300 p-2 dark:border-gray-700">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setShowResetConfirmation(true);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-start text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  <IconRefresh size={20} />
                  <span className="text-sm font-medium">
                    {t('settings.Reset Settings')}
                  </span>
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}

      {showResetConfirmation && (
        <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/50 dark:bg-black/70">
          <div className="mx-4 max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
            <h3 className="mb-3 text-lg font-bold text-black dark:text-white">
              {t('settings.Confirm Reset')}
            </h3>
            <p className="mb-4 text-gray-700 dark:text-gray-300">
              {t('settings.Reset Confirmation Message')}
            </p>
            <div className="flex justify-end space-x-3">
              <button
                className="rounded-md bg-gray-200 px-4 py-2 text-black transition-colors hover:bg-gray-300 dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600"
                onClick={() => setShowResetConfirmation(false)}
              >
                {t('Cancel')}
              </button>
              <button
                className="rounded-md bg-red-600 px-4 py-2 text-white transition-colors hover:bg-red-700"
                onClick={handleConfirmReset}
              >
                {t('Reset')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
