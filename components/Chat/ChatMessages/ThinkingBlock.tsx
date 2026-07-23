'use client';

import {
  IconBrain,
  IconChevronDown,
  IconChevronRight,
} from '@tabler/icons-react';
import { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Streamdown } from 'streamdown';

interface ThinkingBlockProps {
  thinking: string;
  isStreaming?: boolean;
}

export const ThinkingBlock: FC<ThinkingBlockProps> = ({
  thinking,
  isStreaming,
}) => {
  const t = useTranslations();
  // Expanded WHILE the reasoning streams (live progress to hold onto),
  // auto-collapsed once the stream concludes. A manual click wins in both
  // directions and stays sticky — collapsing mid-stream stays collapsed,
  // expanding a finished block stays expanded.
  const [manualOverride, setManualOverride] = useState<boolean | null>(null);
  const isExpanded = manualOverride ?? !!isStreaming;

  // While streaming, keep the live view pinned to the newest reasoning
  // (the body is height-capped so the block doesn't shove the page around).
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isStreaming && isExpanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [thinking, isStreaming, isExpanded]);

  if (!thinking || thinking.trim() === '') {
    return null;
  }

  return (
    <div className="mb-3 border border-blue-200 dark:border-blue-900/50 rounded-lg overflow-hidden bg-blue-50/50 dark:bg-blue-950/20 transition-all">
      <button
        onClick={() => setManualOverride(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100/50 dark:hover:bg-blue-900/30 transition-colors"
        aria-expanded={isExpanded}
        aria-label={
          isExpanded ? t('chat.collapseThinking') : t('chat.expandThinking')
        }
      >
        <div className="flex items-center gap-2">
          <IconBrain size={18} className="flex-shrink-0" />
          {isStreaming ? (
            <span
              className="bg-gradient-to-r from-blue-700 via-blue-600 to-blue-700 dark:from-blue-300 dark:via-blue-200 dark:to-blue-300 bg-clip-text text-transparent animate-shimmer"
              style={{
                backgroundSize: '200% 100%',
              }}
            >
              {t('chat.thinking')}
            </span>
          ) : (
            <span>{t('chat.viewReasoningProcess')}</span>
          )}
        </div>
        {isExpanded ? (
          <IconChevronDown size={18} className="flex-shrink-0" />
        ) : (
          <IconChevronRight size={18} className="flex-shrink-0" />
        )}
      </button>

      {isExpanded && (
        <div
          ref={bodyRef}
          className={`px-4 py-3 border-t border-blue-200 dark:border-blue-900/50 animate-in fade-in slide-in-from-top-1 duration-200 ${
            isStreaming ? 'max-h-60 overflow-y-auto' : ''
          }`}
        >
          <div className="prose dark:prose-invert prose-sm max-w-none text-gray-700 dark:text-gray-300">
            <Streamdown
              isAnimating={isStreaming}
              controls={true}
              shikiTheme={['github-light', 'github-dark']}
            >
              {thinking}
            </Streamdown>
          </div>
        </div>
      )}
    </div>
  );
};

export default ThinkingBlock;
