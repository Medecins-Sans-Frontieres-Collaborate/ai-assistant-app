import { IconChevronDown } from '@tabler/icons-react';
import React, { useEffect, useRef } from 'react';

import { useTranslations } from 'next-intl';

interface SpeedControlProps {
  playbackSpeed: number;
  speeds: number[];
  showDropdown: boolean;
  onToggleDropdown: () => void;
  onChangeSpeed: (speed: number) => void;
  onClickOutside: () => void;
}

/**
 * Playback speed control dropdown component
 */
export const SpeedControl: React.FC<SpeedControlProps> = ({
  playbackSpeed,
  speeds,
  showDropdown,
  onToggleDropdown,
  onChangeSpeed,
  onClickOutside,
}) => {
  const t = useTranslations();
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        onClickOutside();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClickOutside]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={onToggleDropdown}
        className="mx-1 px-2 py-1 text-xs rounded flex items-center bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 focus:outline-none"
        aria-label={t('chat.changePlaybackSpeed')}
        title={t('chat.changePlaybackSpeed')}
      >
        {playbackSpeed}x <IconChevronDown size={14} className="ml-1" />
      </button>

      {showDropdown && (
        <div className="absolute right-0 bottom-full mb-1 w-20 bg-white dark:bg-gray-800 rounded shadow-lg border border-gray-200 dark:border-gray-700 z-10">
          {speeds.map((speed) => (
            <button
              key={speed}
              onClick={() => onChangeSpeed(speed)}
              className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-100 dark:hover:bg-gray-700 ${
                speed === playbackSpeed
                  ? 'bg-gray-100 dark:bg-gray-700 font-semibold'
                  : ''
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
