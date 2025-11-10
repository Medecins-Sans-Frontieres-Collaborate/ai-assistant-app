import React from 'react';
import { IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';

interface PlaybackButtonProps {
  isPlaying: boolean;
  onToggle: () => void;
}

/**
 * Play/pause toggle button for audio playback
 */
export const PlaybackButton: React.FC<PlaybackButtonProps> = ({
  isPlaying,
  onToggle,
}) => {
  return (
    <button
      onClick={onToggle}
      className="mr-2 p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none"
      aria-label={isPlaying ? 'Pause' : 'Play'}
    >
      {isPlaying ? (
        <IconPlayerPause size={20} />
      ) : (
        <IconPlayerPlay size={20} />
      )}
    </button>
  );
};
