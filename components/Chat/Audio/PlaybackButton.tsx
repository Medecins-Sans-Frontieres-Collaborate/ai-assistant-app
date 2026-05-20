import { IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import React from 'react';

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
      className="mr-2 p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
      aria-label={isPlaying ? 'Pause' : 'Play'}
    >
      {isPlaying ? <IconPlayerPause size={20} /> : <IconPlayerPlay size={20} />}
    </button>
  );
};
