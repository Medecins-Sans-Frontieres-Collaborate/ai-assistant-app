'use client';

import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconInfoCircle,
  IconUrgent,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useUI } from '@/client/hooks/ui/useUI';

import { formatAnnouncementText } from '@/lib/utils/app/announcements/formatVariables';

import { AnnouncementAppMessage } from '@/types/appMessages';

import Modal from '@/components/UI/Modal';

interface AnnouncementBannerProps {
  announcement: AnnouncementAppMessage;
  /** 0-based position in the queue, and its length, for the stepper. */
  position: number;
  total: number;
  onStep: (delta: 1 | -1) => void;
  onDismiss: () => void;
}

const SEVERITY_STYLES = {
  info: {
    bar: 'from-blue-100/95 via-blue-50/90 to-blue-100/95 border-blue-200/70 dark:border-blue-800/30',
    accent: 'text-blue-700 dark:text-blue-300',
    badge: 'bg-blue-500/20',
    button: 'bg-blue-600 hover:bg-blue-700 ring-blue-400/30',
    Icon: IconInfoCircle,
  },
  warning: {
    bar: 'from-amber-100/95 via-amber-50/90 to-amber-100/95 border-amber-200/70 dark:border-amber-800/30',
    accent: 'text-amber-700 dark:text-amber-300',
    badge: 'bg-amber-500/20',
    button: 'bg-amber-600 hover:bg-amber-700 ring-amber-400/30',
    Icon: IconAlertTriangle,
  },
  critical: {
    bar: 'from-red-100/95 via-red-50/90 to-red-100/95 border-red-200/70 dark:border-red-800/40',
    accent: 'text-red-700 dark:text-red-300',
    badge: 'bg-red-500/20',
    button: 'bg-red-600 hover:bg-red-700 ring-red-400/30',
    Icon: IconUrgent,
  },
} as const;

/**
 * One admin announcement in the top banner slot.
 *
 * Display length is managed: the bar is ONE line (title, then as much body as
 * fits); "More" opens the full text. A link is a labelled button — the raw
 * URL is never shown, and the body is plain text that is never auto-linked.
 *
 * A non-dismissible announcement has no close button, but can be minimised to
 * a thin strip for the session so a days-long notice does not cost a phone
 * user a permanent slice of the screen.
 */
export function AnnouncementBanner({
  announcement,
  position,
  total,
  onStep,
  onDismiss,
}: AnnouncementBannerProps) {
  const t = useTranslations('announcements');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { showChatbar } = useUI();
  const [expanded, setExpanded] = useState(false);
  const [minimised, setMinimised] = useState(false);

  const style = SEVERITY_STYLES[announcement.severity];
  const { Icon } = style;
  const format = (text: string) =>
    formatAnnouncementText(text, announcement.variables, {
      locale,
      localTimeTemplate: t('localTime', { time: '{time}' }),
    });
  const title = format(announcement.title);
  const body = format(announcement.body);

  const actionLink = announcement.action ? (
    <a
      href={announcement.action.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`px-2 md:px-2.5 py-0.5 md:py-1 text-xs font-medium text-white rounded transition-colors whitespace-nowrap shadow-md ring-1 ${style.button}`}
    >
      {announcement.action.label}
    </a>
  ) : null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[59] pointer-events-none"
      role={announcement.severity === 'critical' ? 'alert' : 'status'}
    >
      <div className="flex">
        {/* Spacer for sidebar on desktop - matches sidebar width */}
        <div
          className={`sidebar-width-target hidden md:block transition-all duration-300 ${
            showChatbar ? 'w-[var(--sidebar-width,260px)]' : 'w-14'
          }`}
        />

        <div className="flex-1 min-w-0 pointer-events-auto">
          <div
            className={`relative bg-gradient-to-r ${style.bar} dark:from-surface-dark/70 dark:via-surface-dark/60 dark:to-surface-dark/70 backdrop-blur-xl shadow-lg border-b animate-fade-in-top`}
          >
            {minimised ? (
              <button
                onClick={() => setMinimised(false)}
                className={`flex w-full items-center justify-center gap-1 py-0.5 text-[11px] font-medium ${style.accent}`}
              >
                <Icon size={12} />
                <span className="truncate">{title}</span>
                <IconChevronDown size={12} />
              </button>
            ) : (
              <div className="px-3 md:px-4 py-1.5 md:py-2">
                <div className="flex items-center justify-between gap-2 md:gap-3">
                  <div className="flex items-center gap-1.5 md:gap-2 flex-1 min-w-0">
                    <div
                      className={`p-0.5 md:p-1 rounded flex-shrink-0 ${style.badge}`}
                    >
                      <Icon
                        size={14}
                        className={`${style.accent} md:w-4 md:h-4`}
                      />
                    </div>
                    <p className="flex-1 min-w-0 truncate text-xs text-gray-900 dark:text-white">
                      {/* A delegated notice always says who it is from,
                          so it cannot pass as an org-wide one. */}
                      {announcement.from && (
                        <span className="mr-1.5 rounded bg-black/5 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-gray-600 dark:bg-white/10 dark:text-gray-300">
                          {announcement.from}
                        </span>
                      )}
                      <span className="font-semibold">{title}</span>
                      {body && (
                        <span className="ml-2 font-normal text-gray-700 dark:text-gray-300">
                          {body}
                        </span>
                      )}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 md:gap-1.5 flex-shrink-0">
                    {total > 1 && (
                      <span className="hidden sm:flex items-center text-[11px] text-gray-600 dark:text-gray-400">
                        <button
                          onClick={() => onStep(-1)}
                          aria-label={t('previous')}
                          className="p-0.5 hover:text-gray-900 dark:hover:text-white"
                        >
                          <IconChevronLeft size={14} />
                        </button>
                        {t('position', { current: position + 1, total })}
                        <button
                          onClick={() => onStep(1)}
                          aria-label={t('next')}
                          className="p-0.5 hover:text-gray-900 dark:hover:text-white"
                        >
                          <IconChevronRight size={14} />
                        </button>
                      </span>
                    )}
                    <button
                      onClick={() => setExpanded(true)}
                      className={`px-1.5 md:px-2 py-0.5 md:py-1 text-xs font-medium hover:underline whitespace-nowrap ${style.accent}`}
                    >
                      {t('more')}
                    </button>
                    <span className="hidden sm:inline-block">{actionLink}</span>
                    {announcement.dismissible ? (
                      <button
                        onClick={onDismiss}
                        className="p-0.5 md:p-1 hover:bg-gray-200/50 dark:hover:bg-gray-700/50 rounded transition-colors text-gray-700 dark:text-gray-300"
                        aria-label={tCommon('dismissBanner')}
                      >
                        <IconX size={14} className="md:w-4 md:h-4" />
                      </button>
                    ) : (
                      <button
                        onClick={() => setMinimised(true)}
                        className="p-0.5 md:p-1 hover:bg-gray-200/50 dark:hover:bg-gray-700/50 rounded transition-colors text-gray-700 dark:text-gray-300"
                        aria-label={t('minimise')}
                      >
                        <IconChevronUp size={14} className="md:w-4 md:h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="pointer-events-auto">
        <Modal
          isOpen={expanded}
          onClose={() => setExpanded(false)}
          title={title}
          size="sm"
          icon={<Icon size={20} className={style.accent} />}
        >
          <div className="space-y-4">
            {body && (
              <p className="whitespace-pre-line text-sm text-gray-800 dark:text-gray-200">
                {body}
              </p>
            )}
            {announcement.from && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('from', { sender: announcement.from })}
              </p>
            )}
            {actionLink && <div>{actionLink}</div>}
          </div>
        </Modal>
      </div>
    </div>
  );
}
