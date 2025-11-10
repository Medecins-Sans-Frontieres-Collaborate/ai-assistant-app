import {
  IconDatabase,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconHelp,
  IconMenu2,
  IconMessage,
  IconUser,
  IconX,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { SettingsSection } from './types';

interface MobileSettingsHeaderProps {
  activeSection: SettingsSection;
  setActiveSection: (section: SettingsSection) => void;
}

export const MobileSettingsHeader: FC<MobileSettingsHeaderProps> = ({
  activeSection,
  setActiveSection,
}) => {
  const t = useTranslations();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

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
    <>
      <div className="sticky top-0 bg-white dark:bg-[#171717] p-4 border-b border-gray-300 dark:border-neutral-700 z-20 rounded-t-lg">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">
            {activeItem?.label || t('Settings')}
          </h2>
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-neutral-700 text-black dark:text-white"
            aria-label={t('common.toggleMenu')}
          >
            {isMenuOpen ? <IconX size={20} /> : <IconMenu2 size={20} />}
          </button>
        </div>
      </div>

      {/* Menu Overlay */}
      {isMenuOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-30"
            onClick={() => setIsMenuOpen(false)}
          />
          <div className="fixed top-[65px] left-0 right-0 bg-white dark:bg-[#171717] border-b border-gray-300 dark:border-neutral-700 z-40 max-h-[60vh] overflow-y-auto">
            {navigationItems.map((item) => (
              <button
                key={item.section}
                onClick={() => {
                  setActiveSection(item.section);
                  setIsMenuOpen(false);
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
        </>
      )}
    </>
  );
};
