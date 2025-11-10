import React from 'react';

interface ProgressBarProps {
  progress: number;
  onSeek: (e: React.MouseEvent<HTMLDivElement>) => void;
}

/**
 * Seekable audio progress bar
 */
export const ProgressBar: React.FC<ProgressBarProps> = ({ progress, onSeek }) => {
  return (
    <div
      className="relative h-2 rounded-full bg-gray-200 dark:bg-gray-700 cursor-pointer"
      onClick={onSeek}
      role="progressbar"
      aria-valuenow={Math.round(progress)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Audio progress"
    >
      <div
        className="absolute top-0 left-0 h-2 rounded-full bg-blue-500 dark:bg-blue-600 transition-all duration-100"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
};
