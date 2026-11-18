'use client';

import {
  IconArrowUp,
  IconPlayerStopFilled,
  IconWand,
} from '@tabler/icons-react';
import { FormEvent, KeyboardEvent, useId, useState } from 'react';

import { useTranslations } from 'next-intl';

import { MAX_CHANGE_INSTRUCTION_CHARS } from '@/lib/utils/shared/translation/changeRequest';

import { ElapsedTime } from '../Shared/Progress/ElapsedTime';

interface ChangeRequestBarProps {
  /** The instruction being worked on, while a request is running. */
  runningInstruction?: string;
  /** Epoch milliseconds the running request started at. */
  runningSince?: number;
  /** True after a request has produced edits ("ask for another"). */
  hasResult: boolean;
  /** Why a request cannot be made right now; disables the field. */
  disabledReason?: string;
  /** The assistant's reply to a request that produced no edits. */
  note?: string | null;
  error?: string | null;
  onSubmit: (instruction: string) => void;
  onStop: () => void;
}

/**
 * Where the user asks for a change to the translation in words. The request
 * comes back as suggested edits; this bar only collects the instruction and
 * shows that work is under way, with a way to stop it.
 */
export function ChangeRequestBar({
  runningInstruction,
  runningSince,
  hasResult,
  disabledReason,
  note,
  error,
  onSubmit,
  onStop,
}: ChangeRequestBarProps) {
  const t = useTranslations('workflows');
  // The shell can mount two workspaces at once, so a fixed id would repeat.
  const fieldId = useId();
  const [draft, setDraft] = useState('');
  const running = runningInstruction !== undefined;
  const disabled = running || Boolean(disabledReason);

  const submit = () => {
    const instruction = draft.trim();
    if (!instruction || disabled) return;
    setDraft('');
    onSubmit(instruction);
  };
  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter while composing (IME) confirms the composition, not the request.
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-700">
      <form onSubmit={onFormSubmit} className="flex items-center gap-2">
        <label
          htmlFor={fieldId}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-2.5 focus-within:border-blue-600 dark:border-gray-700 dark:bg-surface-dark-elevated"
          title={disabledReason}
        >
          <IconWand
            size={15}
            aria-hidden
            className="shrink-0 text-gray-500 dark:text-gray-400"
          />
          <span className="sr-only">{t('translation.changeLabel')}</span>
          <input
            id={fieldId}
            data-change-request-field
            type="text"
            value={running ? runningInstruction : draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            maxLength={MAX_CHANGE_INSTRUCTION_CHARS}
            autoComplete="off"
            placeholder={
              hasResult
                ? t('translation.changePlaceholderAnother')
                : t('translation.changePlaceholder')
            }
            className="min-h-[36px] min-w-0 flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-500 focus:outline-none disabled:text-gray-500 dark:text-gray-100 dark:placeholder-gray-400 dark:disabled:text-gray-400"
          />
        </label>
        {running ? (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-lg border border-gray-400 px-2.5 py-1 text-xs font-medium text-gray-900 hover:bg-gray-100 dark:border-gray-500 dark:text-gray-100 dark:hover:bg-surface-dark-elevated"
          >
            <IconPlayerStopFilled size={12} aria-hidden />
            {t('translation.stop')}
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !draft.trim()}
            aria-label={t('translation.changeSend')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-300 text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-elevated dark:text-white dark:hover:bg-gray-700"
          >
            <IconArrowUp size={16} aria-hidden />
          </button>
        )}
      </form>
      {running && (
        <p
          role="status"
          className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-gray-500 dark:text-gray-400"
        >
          <span
            aria-hidden
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"
          />
          {t('translation.changeWorking')}
          <span aria-hidden>·</span>
          <ElapsedTime since={runningSince} className="tabular-nums" />
          <span aria-hidden>·</span>
          {t('translation.changeNothingApplied')}
        </p>
      )}
      {!running && disabledReason && (
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          {disabledReason}
        </p>
      )}
      {!running && note && (
        <p
          role="status"
          className="mt-1.5 max-w-[75ch] text-xs text-gray-700 dark:text-gray-300"
        >
          {note}
        </p>
      )}
      {!running && error && (
        <p
          role="alert"
          className="mt-1.5 text-xs text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}
