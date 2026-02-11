'use client';

import { IconAlertTriangle, IconX } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { useVersionCheck } from '@/client/hooks/app/useVersionCheck';
import { useUI } from '@/client/hooks/ui/useUI';

export function UpdateBanner() {
  const t = useTranslations();
  const { showChatbar } = useUI();
  const { isUpdateAvailable, dismiss } = useVersionCheck();

  if (!isUpdateAvailable) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[59] pointer-events-none">
      <div className="flex">
        {/* Spacer for sidebar on desktop - matches sidebar width */}
        <div
          className={`hidden md:block transition-all duration-300 ${
            showChatbar ? 'w-[260px]' : 'w-14'
          }`}
        />

        {/* Banner content */}
        <div className="flex-1 pointer-events-auto">
          <div className="relative overflow-hidden animate-fade-in-top">
            <div className="relative bg-gradient-to-r from-amber-100/95 via-amber-50/90 to-amber-100/95 dark:from-[#212121]/70 dark:via-[#212121]/60 dark:to-[#212121]/70 backdrop-blur-xl shadow-lg border-b border-amber-200/70 dark:border-amber-800/30">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-transparent dark:from-amber-600/15 dark:via-amber-500/15 dark:to-amber-600/15 pointer-events-none" />
              <div className="px-3 md:px-4 py-1.5 md:py-2">
                <div className="flex items-center justify-between gap-2 md:gap-3">
                  <div className="flex items-center gap-1.5 md:gap-2 flex-1 min-w-0">
                    <div className="p-0.5 md:p-1 bg-amber-500/20 rounded flex-shrink-0">
                      <IconAlertTriangle
                        size={14}
                        className="text-amber-600 dark:text-amber-400 md:w-4 md:h-4 animate-pulse"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-900 dark:text-white truncate">
                        {t('updateBanner.title')}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 md:gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => window.location.reload()}
                      className="px-2 md:px-2.5 py-0.5 md:py-1 text-[10px] md:text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded transition-colors whitespace-nowrap shadow-[0_2px_12px_rgba(217,119,6,0.45)] hover:shadow-[0_2px_16px_rgba(217,119,6,0.55)] dark:shadow-[0_2px_12px_rgba(251,191,36,0.4)] dark:hover:shadow-[0_2px_16px_rgba(251,191,36,0.5)] ring-1 ring-amber-400/30 dark:ring-amber-400/50"
                    >
                      <span className="md:hidden">
                        {t('updateBanner.refresh')}
                      </span>
                      <span className="hidden md:inline">
                        {t('updateBanner.refreshNow')}
                      </span>
                    </button>
                    <button
                      onClick={dismiss}
                      className="p-0.5 md:p-1 hover:bg-gray-200/50 dark:hover:bg-gray-700/50 rounded transition-colors text-gray-700 dark:text-gray-300"
                      aria-label={t('common.dismissBanner')}
                    >
                      <IconX size={14} className="md:w-4 md:h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
