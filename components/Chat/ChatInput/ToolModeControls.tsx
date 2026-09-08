'use client';

import { IconCode, IconLock, IconWorld } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import {
  ToolLimitGate,
  useAgentToolGates,
  useToolLimitGates,
} from '@/client/hooks/settings/useAgentToolGates';
import { useResetCountdown } from '@/client/hooks/settings/useMyLimits';
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
 *
 * Admin usage limits (docs/LIMITS_USER_FACING_UX.md §7.4) LOCK a row rather
 * than hide it: the segments render disabled with a lock and a reason, and
 * the displayed state is Off whatever the persisted default says — the
 * preference itself is never rewritten, so it returns when the gate lifts.
 * Day budgets annotate the row when low and, at 0, note that the model will
 * answer without the tool (the toggle stays usable; the server degrades).
 */
export const ToolModeControls: FC = () => {
  const t = useTranslations('toolModes');
  const tGates = useTranslations('limitsUx.gates');
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
  const toolLimits = useToolLimitGates();
  // Called unconditionally (both rows may be hidden by the agent gates, but
  // that never changes the hook call count across renders) so the exhausted
  // note can name when the budget comes back, not just that it is gone.
  const searchResetLabel = useResetCountdown(
    toolLimits.webSearch.budget?.resetAt,
  );
  const interpreterResetLabel = useResetCountdown(
    toolLimits.codeInterpreter.budget?.resetAt,
  );

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

  const searchLocked = toolLimits.webSearch.blocked;
  const interpreterLocked = toolLimits.codeInterpreter.blocked;
  const searchLockReason = tGates('blocked', {
    feature: tGates('features.webSearch'),
  });
  const interpreterLockReason = tGates('blocked', {
    feature: tGates('features.codeInterpreter'),
  });

  const defaultSearch =
    selectedConversation.defaultSearchMode ?? SearchMode.INTELLIGENT;
  // Effective state: a policy lock reads as Off regardless of the composer
  // force or the persisted default (both left untouched).
  const searchState: TriState = searchLocked
    ? 'off'
    : searchMode === SearchMode.ALWAYS
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
  const interpreterState: TriState = interpreterLocked
    ? 'off'
    : interpreterMode === InterpreterMode.ALWAYS
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
    disabled = false,
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      className={`rounded-md px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
          : 'text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700'
      }`}
    >
      {label}
    </button>
  );

  // `lockReason` disables every segment and hangs the reason off the group
  // as its tooltip.
  const triSegments = (
    state: TriState,
    onSet: (s: TriState) => void,
    lockReason?: string,
  ) => (
    <span
      className="flex flex-shrink-0 items-center gap-0.5 rounded-lg border border-gray-200 p-0.5 dark:border-gray-700"
      title={lockReason}
      aria-disabled={lockReason ? true : undefined}
    >
      {(['off', 'auto', 'always'] as const).map((s) =>
        segment(state === s, t(s), () => onSet(s), s, Boolean(lockReason)),
      )}
    </span>
  );

  const lockIcon = (reason: string, testId: string) => (
    <span
      role="img"
      aria-label={reason}
      title={reason}
      data-testid={testId}
      className="flex flex-shrink-0 items-center text-gray-400 dark:text-gray-500"
    >
      <IconLock size={12} aria-hidden="true" />
    </span>
  );

  // Under the row: the lock reason while locked, else the budget annotation.
  const rowNote = (
    gate: ToolLimitGate,
    lockReason: string,
    resetLabel: string | null,
  ) => {
    if (gate.blocked) {
      return (
        <p className="pl-6 text-[11px] text-gray-500 dark:text-gray-400">
          {lockReason}
        </p>
      );
    }
    if (gate.exhausted) {
      return (
        <p className="pl-6 text-[11px] text-amber-700 dark:text-amber-400">
          {resetLabel
            ? tGates('exhaustedResets', { resets: resetLabel })
            : tGates('exhausted')}
        </p>
      );
    }
    if (gate.low && gate.budget) {
      return (
        <p className="pl-6 text-[11px] text-gray-500 dark:text-gray-400">
          {tGates('remaining', { count: gate.budget.remaining })}
        </p>
      );
    }
    return null;
  };

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
            {searchLocked && lockIcon(searchLockReason, 'tool-lock-webSearch')}
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
            {triSegments(
              searchState,
              setSearchState,
              searchLocked ? searchLockReason : undefined,
            )}
          </div>
          {rowNote(toolLimits.webSearch, searchLockReason, searchResetLabel)}
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
        <>
          <div className="flex items-center gap-2">
            <IconCode
              size={14}
              className="flex-shrink-0 text-emerald-600"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-xs text-gray-800 dark:text-gray-200">
              {t('codeInterpreter')}
            </span>
            {interpreterLocked &&
              lockIcon(interpreterLockReason, 'tool-lock-codeInterpreter')}
            {triSegments(
              interpreterState,
              setInterpreterState,
              interpreterLocked ? interpreterLockReason : undefined,
            )}
          </div>
          {rowNote(
            toolLimits.codeInterpreter,
            interpreterLockReason,
            interpreterResetLabel,
          )}
        </>
      )}
    </div>
  );
};
