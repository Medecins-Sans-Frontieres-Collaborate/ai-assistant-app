'use client';

import React from 'react';

interface TabEmptyStateProps {
  title: string;
  subtitle: string;
  sectionIcon: React.ReactNode;
  sectionTitle: string;
  tipIcon: React.ReactNode;
  tipText: string;
  ctaIcon: React.ReactNode;
  ctaLabel: string;
  onCtaClick: () => void;
  children: React.ReactNode;
}

export function TabEmptyState({
  title,
  subtitle,
  sectionIcon,
  sectionTitle,
  tipIcon,
  tipText,
  ctaIcon,
  ctaLabel,
  onCtaClick,
  children,
}: TabEmptyStateProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex flex-col overflow-y-auto min-h-0">
        <div className="max-w-3xl w-full mx-auto my-auto space-y-8 p-8">
          {/* Header */}
          <div className="text-center space-y-2">
            <h3 className="text-2xl font-semibold text-gray-900 dark:text-white">
              {title}
            </h3>
            <p className="text-gray-600 dark:text-gray-400">{subtitle}</p>
          </div>

          {/* Section */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
            <div className="flex items-center gap-2 mb-4">
              {sectionIcon}
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                {sectionTitle}
              </h4>
            </div>

            <div className="space-y-3">
              {children}

              {/* Usage tip */}
              <div className="flex items-start gap-3 p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
                <div className="shrink-0 w-6 h-6 flex items-center justify-center rounded bg-neutral-200 dark:bg-neutral-700 mt-0.5">
                  {tipIcon}
                </div>
                <div className="flex-1">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {tipText}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="shrink-0 flex justify-center p-4 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={onCtaClick}
          className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-lg"
        >
          {ctaIcon}
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}
