'use client';

import { IconCode, IconWorld } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useAgentToolGates } from '@/client/hooks/settings/useAgentToolGates';
import { useSettings } from '@/client/hooks/settings/useSettings';

import { InterpreterMode } from '@/types/interpreterMode';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { useChatInputStore } from '@/client/stores/chatInputStore';

type TriState = 'off' | 'auto' | 'always';

/**
 * TOOLS group of the capabilities tray: web search and code interpreter as
 * one Off / Auto / Always control each, uniting the two scopes that used to
 * live apart (conversation default in the model picker, per-turn force in
 * the `+` menu):
 *
 * - off    → conversation default OFF (never runs)
 * - auto   → conversation default INTELLIGENT/AGENT (router decides per turn)
 * - always → composer force (SearchMode/InterpreterMode.ALWAYS) for upcoming
 *            messages; the conversation default is left alone, so removing
 *            the composer badge falls back to it, unchanged.
 *
 * Off/Auto also update the GLOBAL defaults, exactly as the removed
 * SearchModeSection/InterpreterModeSection did — a deliberate parity, not
 * an accident. Search-result tuning (count/freshness) lives in Settings →
 * Web Search. Rows hide under the same agent gates as the `+` menu.
 */
export const ToolModeControls: FC = () => {
  const t = useTranslations('toolModes');
  const { selectedConversation, updateConversation } = useConversations();
  const {
    defaultInterpreterMode,
    setDefaultSearchMode,
    setDefaultInterpreterMode,
  } = useSettings();
  const searchMode = useChatInputStore((s) => s.searchMode);
  const setSearchMode = useChatInputStore((s) => s.setSearchMode);
  const interpreterMode = useChatInputStore((s) => s.interpreterMode);
  const setInterpreterMode = useChatInputStore((s) => s.setInterpreterMode);
  const { hideWebSearch, hideCodeInterpreter } = useAgentToolGates();

  if (!selectedConversation) return null;
  if (hideWebSearch && hideCodeInterpreter) return null;

  const model = selectedConversation.model;
  const modelConfig = OpenAIModels[model?.id as OpenAIModelID] as
    | OpenAIModel
    | undefined;
  // Same rule the model picker used: Azure agent search needs an agentId on
  // the catalog config or the (possibly synthesized) model object.
  const agentSearchAvailable =
    modelConfig?.agentId !== undefined || model?.agentId !== undefined;

  const defaultSearch =
    selectedConversation.defaultSearchMode ?? SearchMode.INTELLIGENT;
  const searchState: TriState =
    searchMode === SearchMode.ALWAYS
      ? 'always'
      : defaultSearch === SearchMode.OFF
        ? 'off'
        : 'auto';
  // AGENT default without agent support displays (and re-saves) as
  // INTELLIGENT — mirror of the picker's displaySearchMode fix.
  const searchRouting =
    defaultSearch === SearchMode.AGENT && agentSearchAvailable
      ? SearchMode.AGENT
      : SearchMode.INTELLIGENT;

  const setSearchState = (state: TriState) => {
    if (state === 'always') {
      setSearchMode(SearchMode.ALWAYS);
      return;
    }
    const mode = state === 'off' ? SearchMode.OFF : searchRouting;
    updateConversation(selectedConversation.id, { defaultSearchMode: mode });
    setDefaultSearchMode(mode);
    setSearchMode(mode);
  };

  const setSearchRouting = (mode: SearchMode) => {
    updateConversation(selectedConversation.id, { defaultSearchMode: mode });
    setDefaultSearchMode(mode);
    if (searchState === 'auto') setSearchMode(mode);
  };

  const defaultInterpreter =
    selectedConversation.defaultInterpreterMode ?? defaultInterpreterMode;
  const interpreterState: TriState =
    interpreterMode === InterpreterMode.ALWAYS
      ? 'always'
      : defaultInterpreter === InterpreterMode.OFF
        ? 'off'
        : 'auto';

  const setInterpreterState = (state: TriState) => {
    if (state === 'always') {
      setInterpreterMode(InterpreterMode.ALWAYS);
      return;
    }
    const mode =
      state === 'off' ? InterpreterMode.OFF : InterpreterMode.INTELLIGENT;
    updateConversation(selectedConversation.id, {
      defaultInterpreterMode: mode,
    });
    setDefaultInterpreterMode(mode);
    setInterpreterMode(mode);
  };

  const segment = (
    active: boolean,
    label: string,
    onClick: () => void,
    key: string,
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
          : 'text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700'
      }`}
    >
      {label}
    </button>
  );

  const triSegments = (state: TriState, onSet: (s: TriState) => void) => (
    <span className="flex flex-shrink-0 items-center gap-0.5 rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
      {(['off', 'auto', 'always'] as const).map((s) =>
        segment(state === s, t(s), () => onSet(s), s),
      )}
    </span>
  );

  return (
    <div className="mt-2 space-y-1.5 border-t border-gray-200 pt-2 dark:border-gray-700">
      {!hideWebSearch && (
        <>
          <div className="flex items-center gap-2">
            <IconWorld
              size={14}
              className="flex-shrink-0 text-blue-500"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-xs text-gray-800 dark:text-gray-200">
              {t('webSearch')}
            </span>
            {agentSearchAvailable && searchState !== 'off' && (
              <span className="flex flex-shrink-0 items-center gap-0.5">
                {segment(
                  searchRouting === SearchMode.INTELLIGENT,
                  t('routingPrivacy'),
                  () => setSearchRouting(SearchMode.INTELLIGENT),
                  'privacy',
                )}
                {segment(
                  searchRouting === SearchMode.AGENT,
                  t('routingAgent'),
                  () => setSearchRouting(SearchMode.AGENT),
                  'agent',
                )}
              </span>
            )}
            {triSegments(searchState, setSearchState)}
          </div>
          {searchRouting === SearchMode.AGENT && searchState !== 'off' && (
            <p className="pl-6 text-[11px] text-amber-700 dark:text-amber-400">
              {t('agentRoutingNote')}{' '}
              <a
                href="/info/search-mode"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {t('learnMore')}
              </a>
            </p>
          )}
        </>
      )}
      {!hideCodeInterpreter && (
        <div className="flex items-center gap-2">
          <IconCode
            size={14}
            className="flex-shrink-0 text-emerald-600"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-xs text-gray-800 dark:text-gray-200">
            {t('codeInterpreter')}
          </span>
          {triSegments(interpreterState, setInterpreterState)}
        </div>
      )}
    </div>
  );
};
