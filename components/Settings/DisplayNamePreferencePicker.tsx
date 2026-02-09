'use client';

import {
  IconId,
  IconPencil,
  IconUser,
  IconUserCircle,
  IconUserOff,
} from '@tabler/icons-react';
import { FC } from 'react';

import { Session } from 'next-auth';
import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import { getUserDisplayName } from '@/lib/utils/app/user/displayName';

import { DisplayNamePreference } from '@/types/settings';

import { Tooltip } from '@/components/UI/Tooltip';

interface DisplayNamePreferencePickerProps {
  /** 'inline' for Settings modal, 'popover' for hover popover */
  variant: 'inline' | 'popover';
  /** User session for preview */
  user?: Session['user'];
  /** Show preview text (default: true for inline, false for popover) */
  showPreview?: boolean;
  /** Show help text about UI-only behavior (default: true for inline, false for popover) */
  showHelpText?: boolean;
  /** Callback when popover should close (only used in popover variant) */
  onClose?: () => void;
}

/**
 * Display name preference picker component.
 * Allows users to select how they want to be addressed (first name, last name, full name, custom, or none).
 * Can be used inline in settings or as a compact popover.
 */
export const DisplayNamePreferencePicker: FC<
  DisplayNamePreferencePickerProps
> = ({
  variant,
  user,
  showPreview = variant === 'inline',
  showHelpText = variant === 'inline',
}) => {
  const t = useTranslations();
  const {
    displayNamePreference,
    customDisplayName,
    setDisplayNamePreference,
    setCustomDisplayName,
  } = useSettings();

  const displayNameOptions: {
    key: DisplayNamePreference;
    icon: typeof IconUserCircle;
    tooltip: string;
  }[] = [
    {
      key: 'firstName',
      icon: IconUserCircle,
      tooltip: t('settings.First Name'),
    },
    {
      key: 'lastName',
      icon: IconId,
      tooltip: t('settings.Last Name'),
    },
    {
      key: 'fullName',
      icon: IconUser,
      tooltip: t('settings.Full Name'),
    },
    { key: 'custom', icon: IconPencil, tooltip: t('settings.Custom') },
    { key: 'none', icon: IconUserOff, tooltip: t('settings.None') },
  ];

  const isPopover = variant === 'popover';

  return (
    <div className={isPopover ? '' : ''}>
      {/* Label */}
      <div
        className={`text-gray-600 dark:text-gray-400 ${isPopover ? 'text-xs mb-2' : 'text-sm mb-2'}`}
      >
        {t('settings.howShouldWeAddressYou')}
      </div>

      {/* Icon Buttons */}
      <div
        className={`flex items-center gap-1 p-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 ${isPopover ? 'w-full justify-center' : 'w-fit'}`}
      >
        {displayNameOptions.map(({ key, icon: Icon, tooltip }) => (
          <Tooltip key={key} content={tooltip}>
            <button
              onClick={() => setDisplayNamePreference(key)}
              className={`p-2 rounded-md transition-all ${
                displayNamePreference === key
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
              aria-label={tooltip}
              aria-pressed={displayNamePreference === key}
            >
              <Icon size={isPopover ? 16 : 18} />
            </button>
          </Tooltip>
        ))}
      </div>

      {/* Custom Name Input */}
      {displayNamePreference === 'custom' && (
        <div className={isPopover ? 'mt-2' : 'mt-3'}>
          <input
            type="text"
            value={customDisplayName}
            onChange={(e) => setCustomDisplayName(e.target.value)}
            placeholder={t('settings.Custom Display Name Placeholder')}
            className={`w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 ${isPopover ? 'text-xs' : 'text-sm'}`}
            maxLength={50}
            autoFocus={isPopover}
          />
        </div>
      )}

      {/* Preview */}
      {showPreview && (
        <div
          className={`text-gray-500 dark:text-gray-400 italic ${isPopover ? 'mt-2 text-xs' : 'mt-3 text-sm'}`}
        >
          {(() => {
            const previewName = getUserDisplayName(
              user,
              displayNamePreference,
              customDisplayName,
            );
            return t('settings.displayNamePreview', {
              greeting: previewName
                ? t('emptyState.greetingWithName', { name: previewName })
                : t('emptyState.greeting'),
            });
          })()}
        </div>
      )}

      {/* UI-only note */}
      {showHelpText && (
        <p
          className={`text-gray-500 dark:text-gray-400 ${isPopover ? 'mt-2 text-[10px]' : 'mt-2 text-xs'}`}
        >
          {t('settings.displayNameUIOnly')}
        </p>
      )}
    </div>
  );
};
