import { IconCheck, IconTool } from '@tabler/icons-react';
import { FC, ReactNode } from 'react';

interface ModelCardProps {
  id: string;
  name: string;
  isSelected: boolean;
  onClick: () => void;
  icon?: ReactNode;
  badge?: ReactNode;
}

/**
 * Reusable model card component
 * Used in ModelSelect for both base models and custom agents
 */
export const ModelCard: FC<ModelCardProps> = ({
  id,
  name,
  isSelected,
  onClick,
  icon,
  badge,
}) => {
  return (
    <button
      key={id}
      onClick={onClick}
      className={`
        w-full text-left p-3 rounded-lg transition-all duration-150
        ${
          isSelected
            ? 'bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-600'
            : 'bg-white dark:bg-[#212121] border-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700'
        }
      `}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium text-sm text-gray-900 dark:text-white">
            {name}
          </span>
          {badge}
        </div>
        {isSelected && (
          <IconCheck size={16} className="text-blue-600 dark:text-blue-400" />
        )}
      </div>
    </button>
  );
};
