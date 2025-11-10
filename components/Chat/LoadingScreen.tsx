import React from 'react';

/**
 * Loading screen shown during app initialization
 * Displays while data is being loaded from localStorage
 */
export function LoadingScreen() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-white dark:bg-[#212121]">
      <div className="h-8 w-8 rounded-full bg-gray-500 dark:bg-gray-400 animate-breathing"></div>
    </div>
  );
}
