'use client';

import {
  IconChevronDown,
  IconChevronRight,
  IconCode,
} from '@tabler/icons-react';
import React, { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { CodeInterpreterOutput as CodeInterpreterOutputType } from '@/types/codeInterpreter';

import { GeneratedFilePreview } from './GeneratedFilePreview';

/**
 * Props for CodeInterpreterOutput component.
 */
interface CodeInterpreterOutputProps {
  /** Code Interpreter outputs (logs, images, files) */
  outputs: CodeInterpreterOutputType[];
  /** Python code that was executed */
  code?: string;
  /** Whether code is currently executing */
  isExecuting: boolean;
  /** Whether code block should be expanded by default */
  defaultExpanded?: boolean;
}

/**
 * Renders Code Interpreter execution results.
 *
 * Features:
 * - Collapsible Python code blocks (syntax highlighted)
 * - Expanded by default during execution
 * - Auto-collapse after execution completes
 * - Execution logs in monospace format
 * - Inline images for charts/plots
 * - File download buttons for generated files
 */
export const CodeInterpreterOutput: FC<CodeInterpreterOutputProps> = ({
  outputs,
  code,
  isExecuting,
  defaultExpanded = true,
}) => {
  const t = useTranslations();

  // Track code block expansion state
  // Default to expanded if executing, collapsed after completion
  const [isCodeExpanded, setIsCodeExpanded] = useState(
    defaultExpanded || isExecuting,
  );

  // Auto-collapse when execution completes
  React.useEffect(() => {
    if (!isExecuting && defaultExpanded === false) {
      setIsCodeExpanded(false);
    }
  }, [isExecuting, defaultExpanded]);

  // Separate outputs by type
  const logs = outputs.filter((o) => o.type === 'logs');
  const images = outputs.filter((o) => o.type === 'image');
  const files = outputs.filter((o) => o.type === 'file');

  const hasCode = code && code.trim().length > 0;
  const hasLogs = logs.length > 0 && logs.some((l) => l.content?.trim());
  const hasImages = images.length > 0;
  const hasFiles = files.length > 0;

  // Don't render if nothing to show
  if (!hasCode && !hasLogs && !hasImages && !hasFiles) {
    return null;
  }

  return (
    <div className="my-4 space-y-3">
      {/* Python Code Block */}
      {hasCode && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          {/* Header - clickable to expand/collapse */}
          <button
            onClick={() => setIsCodeExpanded(!isCodeExpanded)}
            className="flex items-center gap-2 w-full px-3 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-left"
          >
            {isCodeExpanded ? (
              <IconChevronDown size={16} className="text-gray-500" />
            ) : (
              <IconChevronRight size={16} className="text-gray-500" />
            )}
            <IconCode size={16} className="text-blue-500" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('codeInterpreter.pythonCode')}
            </span>
            {isExecuting && (
              <span className="ml-2 text-xs text-green-500 animate-pulse">
                {t('codeInterpreter.running')}
              </span>
            )}
          </button>

          {/* Code content - collapsible */}
          {isCodeExpanded && (
            <div className="p-3 bg-gray-900 overflow-x-auto">
              <pre className="text-sm font-mono text-gray-100 whitespace-pre-wrap">
                <code>{code}</code>
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Execution Logs */}
      {hasLogs && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-3 py-2 bg-gray-100 dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('codeInterpreter.output')}
          </div>
          <div className="p-3 bg-gray-50 dark:bg-gray-900 overflow-x-auto">
            {logs.map((log, index) => (
              <pre
                key={index}
                className="text-sm font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap"
              >
                {log.content}
              </pre>
            ))}
          </div>
        </div>
      )}

      {/* Generated Images */}
      {hasImages && (
        <div className="space-y-2">
          {images.map((image, index) => (
            <GeneratedFilePreview key={index} output={image} />
          ))}
        </div>
      )}

      {/* Generated Files */}
      {hasFiles && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('codeInterpreter.generatedFiles')}
          </div>
          {files.map((file, index) => (
            <GeneratedFilePreview key={index} output={file} />
          ))}
        </div>
      )}
    </div>
  );
};

export default CodeInterpreterOutput;
