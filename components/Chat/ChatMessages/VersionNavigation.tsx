import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { FC } from 'react';

interface VersionNavigationProps {
  currentVersion: number;
  totalVersions: number;
  onPrevious: () => void;
  onNext: () => void;
}

/**
 * Displays arrow navigation for switching between message versions.
 * Shows "< 2/5 >" format with disabled arrows at boundaries.
 * Only renders if there are multiple versions.
 */
export const VersionNavigation: FC<VersionNavigationProps> = ({
  currentVersion,
  totalVersions,
  onPrevious,
  onNext,
}) => {
  if (totalVersions <= 1) return null;

  const canGoPrevious = currentVersion > 1;
  const canGoNext = currentVersion < totalVersions;

  return (
    <div className="flex items-center gap-0.5 text-sm text-gray-500 dark:text-gray-400">
      <button
        onClick={onPrevious}
        disabled={!canGoPrevious}
        className={`p-1 rounded transition-colors ${
          canGoPrevious
            ? 'hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            : 'opacity-30 cursor-not-allowed'
        }`}
        aria-label="Previous version"
      >
        <IconChevronLeft size={16} />
      </button>
      <span className="min-w-[3ch] text-center tabular-nums text-xs">
        {currentVersion}/{totalVersions}
      </span>
      <button
        onClick={onNext}
        disabled={!canGoNext}
        className={`p-1 rounded transition-colors ${
          canGoNext
            ? 'hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            : 'opacity-30 cursor-not-allowed'
        }`}
        aria-label="Next version"
      >
        <IconChevronRight size={16} />
      </button>
    </div>
  );
};

export default VersionNavigation;
