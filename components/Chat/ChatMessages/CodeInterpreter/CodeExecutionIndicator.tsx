'use client';

import { IconCheck, IconCode, IconLoader2, IconX } from '@tabler/icons-react';
import React, { FC } from 'react';

import { useTranslations } from 'next-intl';

/**
 * Props for CodeExecutionIndicator component.
 */
interface CodeExecutionIndicatorProps {
  /** Current execution phase */
  phase: 'uploading' | 'executing' | 'completed' | 'error';
  /** Snippet of code currently being executed (optional) */
  currentCode?: string;
}

/**
 * Shows real-time Code Interpreter execution status.
 *
 * Displays different states:
 * - uploading: "Uploading files..." with progress indicator
 * - executing: "Executing Python..." with animated code indicator
 * - completed: Success state (briefly shown or hidden)
 * - error: Error state with icon
 */
export const CodeExecutionIndicator: FC<CodeExecutionIndicatorProps> = ({
  phase,
  currentCode,
}) => {
  const t = useTranslations();

  // Don't render if completed (success state is brief)
  if (phase === 'completed') {
    return null;
  }

  const getIcon = () => {
    switch (phase) {
      case 'uploading':
        return (
          <IconLoader2
            size={16}
            className="animate-spin text-blue-500 dark:text-blue-400"
          />
        );
      case 'executing':
        return (
          <IconCode
            size={16}
            className="text-green-500 dark:text-green-400 animate-pulse"
          />
        );
      case 'error':
        return <IconX size={16} className="text-red-500 dark:text-red-400" />;
      default:
        return null;
    }
  };

  const getMessage = () => {
    switch (phase) {
      case 'uploading':
        return t('codeInterpreter.uploadingFiles');
      case 'executing':
        return t('codeInterpreter.executingPython');
      case 'error':
        return t('codeInterpreter.executionError');
      default:
        return '';
    }
  };

  const getStatusColor = () => {
    switch (phase) {
      case 'uploading':
        return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800';
      case 'executing':
        return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800';
      case 'error':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
      default:
        return 'bg-gray-50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-800';
    }
  };

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 mb-3 rounded-lg border ${getStatusColor()}`}
    >
      {getIcon()}
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {getMessage()}
      </span>

      {/* Show code snippet when executing */}
      {phase === 'executing' && currentCode && (
        <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-[200px]">
          {currentCode.slice(0, 50)}
          {currentCode.length > 50 ? '...' : ''}
        </span>
      )}
    </div>
  );
};

export default CodeExecutionIndicator;
