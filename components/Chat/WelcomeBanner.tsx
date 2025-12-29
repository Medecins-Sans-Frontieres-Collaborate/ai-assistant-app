'use client';

import { IconSparkles, IconX } from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { useUI } from '@/client/hooks/ui/useUI';

import {
  hasUserDismissedWelcomeBanner,
  saveWelcomeBannerDismissal,
} from '@/lib/utils/app/user/welcomeBanner';

interface WelcomeBannerProps {
  onVisibilityChange?: (isVisible: boolean) => void;
}

/**
 * Welcome V2 banner component
 * Shows a dismissible banner announcing V2 features
 * Renders at the top on desktop, above mobile header on mobile
 */
export function WelcomeBanner({ onVisibilityChange }: WelcomeBannerProps) {
  const t = useTranslations();
  const { data: session, status } = useSession();
  const { showChatbar } = useUI();
  const [isVisible, setIsVisible] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setTimeout(() => {
      setIsMounted(true);
    }, 0);
  }, []);

  useEffect(() => {
    if (status === 'loading' || !session?.user) return;

    // Use email as the user identifier (consistent with terms acceptance)
    const userId = session.user?.mail || session.user?.id || '';
    if (!userId) return;

    // Check if user has already dismissed the banner
    const hasDismissed = hasUserDismissedWelcomeBanner(userId);
    const visible = !hasDismissed;
    setTimeout(() => {
      setIsVisible(visible);
      onVisibilityChange?.(visible);
    }, 0);
  }, [session, status, onVisibilityChange]);

  const handleDismiss = () => {
    if (!session?.user) return;

    const userId = session.user?.mail || session.user?.id || '';
    if (!userId) return;

    saveWelcomeBannerDismissal(userId, 'dismissed');
    setIsVisible(false);
    onVisibilityChange?.(false);
  };

  const handleView = () => {
    if (!session?.user) return;

    const userId = session.user?.mail || session.user?.id || '';
    if (!userId) return;

    saveWelcomeBannerDismissal(userId, 'viewed');
    setIsVisible(false);
    onVisibilityChange?.(false);
  };

  // Don't render anything until mounted (prevents hydration issues)
  if (!isMounted || !isVisible) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] pointer-events-none">
      <div className="flex">
        {/* Spacer for sidebar on desktop - matches sidebar width */}
        <div
          className={`hidden md:block transition-all duration-300 ${
            showChatbar ? 'w-[260px]' : 'w-14'
          }`}
        />

        {/* Banner content */}
        <div className="flex-1 pointer-events-auto">
          <div className="relative overflow-hidden">
            {/* Gradient overlay */}
            <div className="absolute inset-0 bg-gradient-to-r from-red-500/10 via-rose-500/10 to-pink-500/10 dark:from-red-600/15 dark:via-rose-600/15 dark:to-pink-600/15" />

            {/* Glass background */}
            <div className="relative bg-gradient-to-r from-white/70 via-white/60 to-white/70 dark:from-[#212121]/70 dark:via-[#212121]/60 dark:to-[#212121]/70 backdrop-blur-xl shadow-lg border-b border-gray-200/30 dark:border-gray-700/30">
              <div className="px-3 md:px-4 py-1.5 md:py-2">
                <div className="flex items-center justify-between gap-2 md:gap-3">
                  <div className="flex items-center gap-1.5 md:gap-2 flex-1 min-w-0">
                    <div className="p-0.5 md:p-1 bg-red-500/20 rounded flex-shrink-0">
                      <IconSparkles
                        size={14}
                        className="text-red-600 dark:text-red-400 md:w-4 md:h-4"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-900 dark:text-white truncate">
                        Welcome to AI Assistant V2
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 md:gap-1.5 flex-shrink-0">
                    <Link
                      href="/info/welcome-v2"
                      onClick={handleView}
                      className="px-2 md:px-2.5 py-0.5 md:py-1 text-[10px] md:text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded transition-colors whitespace-nowrap shadow-[0_2px_12px_rgba(220,38,38,0.45)] hover:shadow-[0_2px_16px_rgba(220,38,38,0.55)] dark:shadow-[0_2px_12px_rgba(248,113,113,0.4)] dark:hover:shadow-[0_2px_16px_rgba(248,113,113,0.5)] ring-1 ring-red-400/30 dark:ring-red-400/50"
                    >
                      <span className="md:hidden">What's New</span>
                      <span className="hidden md:inline">What's New?</span>
                    </Link>
                    <button
                      onClick={handleDismiss}
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
