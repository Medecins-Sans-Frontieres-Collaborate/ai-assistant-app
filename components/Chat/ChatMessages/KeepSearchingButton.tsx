'use client';

import { IconRefresh } from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  decodeSearchState,
  isContinuableSearchState,
} from '@/lib/utils/shared/searchState';

import { ToolCallRecord } from '@/types/chat';

import { useChatStore } from '@/client/stores/chatStore';

/**
 * Offered under the latest assistant message when its multi-step web search
 * ended short (limit, gave up, or the web engines did not answer). Sends a
 * canned "keep searching" message; the server continues the previous
 * search from the state carried on this message's outcome record rather
 * than starting over (docs/WEB_SEARCH_DEAD_END_PROPOSAL.md §E).
 *
 * Not shown while a response streams or on earlier messages — "keep
 * looking" only means something for the search the user just watched end.
 */
export const KeepSearchingButton: FC<{
  conversationId: string;
  toolCalls: ToolCallRecord[] | undefined;
  isLastMessage: boolean;
  isStreaming: boolean;
}> = ({ conversationId, toolCalls, isLastMessage, isStreaming }) => {
  const t = useTranslations('chat');
  const continueSearch = useChatStore((s) => s.continueSearch);
  const [clicked, setClicked] = useState(false);

  if (!isLastMessage || isStreaming) return null;
  const state =
    toolCalls
      ?.map((record) => decodeSearchState(record))
      .find((decoded) => decoded !== null) ?? null;
  if (!isContinuableSearchState(state)) return null;

  return (
    <div className="my-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={clicked}
        onClick={() => {
          setClicked(true);
          void continueSearch(conversationId, t('keepSearchingMessage'));
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-500/50 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/40"
      >
        <IconRefresh size={14} aria-hidden="true" />
        {t('keepSearching')}
      </button>
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {t('keepSearchingHint')}
      </span>
    </div>
  );
};
