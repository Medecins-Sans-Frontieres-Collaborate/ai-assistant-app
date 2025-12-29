'use client';

import React from 'react';

interface EmptyStateProps {
  userName?: string;
}

/**
 * Empty state header with greeting
 */
export function EmptyState({ userName }: EmptyStateProps) {
  return (
    <div className="flex items-center justify-center">
      {/* Heading */}
      <h1 className="text-2xl font-light bg-gradient-to-r from-[#F73837] from-0% via-rose-500 via-15% to-rose-900 to-100% dark:from-[#F73837] dark:from-0% dark:via-[#FF8A89] dark:via-15% dark:to-gray-400 dark:to-100% bg-clip-text text-transparent">
        How can I help{userName ? `, ${userName}` : ''}?
      </h1>
    </div>
  );
}
