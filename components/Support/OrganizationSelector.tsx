'use client';

import { IconBuilding, IconRefresh } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useOrganizationSupport } from '@/client/hooks/settings/useOrganizationSupport';

import { MSFOrganization, MSF_ORGANIZATIONS } from '@/types/organization';

import { Tooltip } from '@/components/UI/Tooltip';

interface OrganizationSelectorProps {
  /** Additional CSS classes */
  className?: string;
  /** Whether to show the auto-detect reset button when overridden */
  showResetButton?: boolean;
  /** Compact mode for inline usage */
  compact?: boolean;
}

/**
 * Dropdown component for selecting MSF organization for support contacts.
 * Shows the current selection with an indicator if it was auto-detected.
 *
 * @example
 * <OrganizationSelector />
 *
 * @example
 * <OrganizationSelector compact showResetButton={false} />
 */
export const OrganizationSelector: FC<OrganizationSelectorProps> = ({
  className = '',
  showResetButton = true,
  compact = false,
}) => {
  const t = useTranslations();
  const {
    effectiveOrganization,
    detectedOrganization,
    isOverridden,
    setOrganizationPreference,
    resetToAutoDetect,
  } = useOrganizationSupport();

  /**
   * Gets the translated display name for an organization.
   */
  const getOrganizationDisplayName = (org: MSFOrganization): string => {
    const names: Record<MSFOrganization, string> = {
      USA: t('support.organizations.USA'),
      OCG: t('support.organizations.OCG'),
      OCA: t('support.organizations.OCA'),
      FIELD: t('support.organizations.FIELD'),
    };
    return names[org];
  };

  /**
   * Handles organization selection change.
   */
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === 'auto') {
      resetToAutoDetect();
    } else {
      setOrganizationPreference(value as MSFOrganization);
    }
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {!compact && (
        <IconBuilding size={18} className="text-gray-500 dark:text-gray-400" />
      )}

      <select
        value={isOverridden ? effectiveOrganization : 'auto'}
        onChange={handleChange}
        className={`cursor-pointer bg-transparent text-gray-700 dark:text-gray-200 text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800/50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${
          compact ? 'w-auto' : 'min-w-[160px]'
        }`}
      >
        {/* Auto-detect option */}
        <option value="auto" className="bg-white dark:bg-gray-900">
          {t('support.autoDetect')} (
          {getOrganizationDisplayName(detectedOrganization.organization)})
        </option>

        {/* Separator - visual only in some browsers */}
        <option disabled>──────────</option>

        {/* Manual organization options */}
        {MSF_ORGANIZATIONS.map((org) => (
          <option key={org} value={org} className="bg-white dark:bg-gray-900">
            {getOrganizationDisplayName(org)}
          </option>
        ))}
      </select>

      {/* Reset button when overridden */}
      {showResetButton && isOverridden && (
        <Tooltip content={t('support.resetToAutoDetect')}>
          <button
            onClick={resetToAutoDetect}
            className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            <IconRefresh size={16} />
          </button>
        </Tooltip>
      )}
    </div>
  );
};
