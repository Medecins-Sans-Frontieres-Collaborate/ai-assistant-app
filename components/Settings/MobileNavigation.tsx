import {
  IconChevronLeft,
  IconDatabase,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconHelp,
  IconMessage,
  IconShield,
  IconUser,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { SettingsSection } from './types';

interface MobileNavigationProps {
  activeSection: SettingsSection;
  setActiveSection: (section: SettingsSection) => void;
}

export const MobileNavigation: FC<MobileNavigationProps> = ({
  activeSection,
  setActiveSection,
}) => {
  const t = useTranslations();
  const [isExpanded, setIsExpanded] = useState(false);

  // Navigation items configuration
  const navigationItems = [
    {
      section: SettingsSection.GENERAL,
      label: t('General'),
      icon: <IconDeviceDesktop size={20} />,
    },
    {
      section: SettingsSection.CHAT_SETTINGS,
      label: t('Chat Settings'),
      icon: <IconMessage size={20} />,
    },
    {
      section: SettingsSection.DATA_MANAGEMENT,
      label: t('Data Management'),
      icon: <IconDatabase size={20} />,
    },
    {
      section: SettingsSection.ACCOUNT,
      label: t('Account'),
      icon: <IconUser size={20} />,
    },
    {
      section: SettingsSection.MOBILE_APP,
      label: t('Mobile App'),
      icon: <IconDeviceMobile size={20} />,
    },
    {
      section: SettingsSection.HELP_SUPPORT,
      label: t('Help & Support'),
      icon: <IconHelp size={20} />,
    },
  ];

  const activeItem = navigationItems.find(
    (item) => item.section === activeSection,
  );

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white dark:bg-[#171717] border-t border-gray-300 dark:border-neutral-700 z-20">
      {/* Expandable List */}
      {isExpanded && (
        <div className="border-b border-gray-300 dark:border-neutral-700 max-h-[60vh] overflow-y-auto">
          {navigationItems.map((item) => (
            <button
              key={item.section}
              onClick={() => {
                setActiveSection(item.section);
                setIsExpanded(false);
              }}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                item.section === activeSection
                  ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-700'
              }`}
            >
              {item.icon}
              <span className="text-sm font-medium">{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Current Section Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-3"
      >
        <div className="flex items-center gap-3">
          {activeItem?.icon}
          <span className="text-sm font-medium text-black dark:text-white">
            {activeItem?.label}
          </span>
        </div>
        <IconChevronLeft
          size={20}
          className={`text-gray-600 dark:text-gray-400 transform transition-transform ${
            isExpanded ? '-rotate-90' : 'rotate-90'
          }`}
        />
      </button>
    </div>
  );
};
