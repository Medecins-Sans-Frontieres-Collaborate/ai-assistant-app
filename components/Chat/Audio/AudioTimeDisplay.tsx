import React from 'react';

interface AudioTimeDisplayProps {
  currentTime: number;
  duration: number;
  playbackSpeed: number;
}

/**
 * Formats time from seconds to MM:SS
 */
export const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
};

/**
 * Displays current playback time, duration, and playback speed
 */
export const AudioTimeDisplay: React.FC<AudioTimeDisplayProps> = ({
  currentTime,
  duration,
  playbackSpeed,
}) => {
  return (
    <div className="text-xs text-gray-600 dark:text-gray-300">
      {formatTime(currentTime)} / {formatTime(duration)}
      {playbackSpeed !== 1 && (
        <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
          ({playbackSpeed}x)
        </span>
      )}
    </div>
  );
};
