import { FC, ReactNode } from 'react';

interface Tab {
  id: string;
  label: string | ReactNode;
  icon?: ReactNode;
  badge?: number;
  width?: string;
}

interface TabNavigationProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  onClose?: () => void;
  closeIcon?: ReactNode;
}

/**
 * Reusable tab navigation with sliding indicator
 * Used by ModelSelect, CustomizationsModal, etc.
 */
export const TabNavigation: FC<TabNavigationProps> = ({
  tabs,
  activeTab,
  onTabChange,
  onClose,
  closeIcon,
}) => {
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTab);
  const activeTabData = tabs[activeIndex];

  // Calculate transform position for sliding indicator
  const getTransformX = () => {
    let offset = 0;
    for (let i = 0; i < activeIndex; i++) {
      const width = tabs[i].width || '110px';
      offset += parseInt(width);
    }
    return offset;
  };

  return (
    <div className="flex justify-between items-center border-b border-gray-200 dark:border-gray-700 mb-6">
      <div className="flex relative">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors duration-200 flex items-center gap-2 ${
              activeTab === tab.id
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
            style={{ width: tab.width || '110px' }}
          >
            {tab.icon}
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-blue-600 rounded-full">
                {tab.badge}
              </span>
            )}
          </button>
        ))}

        {/* Sliding indicator */}
        <div
          className="absolute bottom-0 h-0.5 bg-blue-600 dark:bg-blue-400 transition-transform duration-300 ease-out"
          style={{
            width: activeTabData?.width || '110px',
            transform: `translateX(${getTransformX()}px)`,
            transition: 'transform 0.3s ease-out, width 0.3s ease-out',
          }}
        />
      </div>

      {onClose && (
        <button
          className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
          onClick={onClose}
        >
          {closeIcon}
        </button>
      )}
    </div>
  );
};
