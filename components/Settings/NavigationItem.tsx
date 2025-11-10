import React, { FC } from 'react';

import { SettingsSection } from './types';

/**
 * Props for the NavigationItem component
 */
interface NavigationItemProps {
  section: SettingsSection;
  activeSection: SettingsSection;
  label: string;
  icon?: React.ReactNode;
  onClick: (section: SettingsSection) => void;
}

/**
 * NavigationItem component for the settings dialog
 * Renders a button that can be clicked to navigate to a different section
 */
export const NavigationItem: FC<NavigationItemProps> = ({
  section,
  activeSection,
  label,
  icon,
  onClick,
}) => {
  const isActive = section === activeSection;

  return (
    <button
      className={`flex items-center w-full text-left p-3 my-1 rounded-lg text-gray-800 dark:text-gray-200 ${
        isActive
          ? 'bg-gray-200 dark:bg-gray-700 font-semibold'
          : 'hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
      onClick={() => onClick(section)}
      aria-current={isActive ? 'page' : undefined}
    >
      {icon && <span className="mr-3">{icon}</span>}
      <span>{label}</span>
    </button>
  );
};
