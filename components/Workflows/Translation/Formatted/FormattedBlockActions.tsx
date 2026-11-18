'use client';

import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { MAX_STEP_INSTRUCTION_CHARS } from '@/lib/utils/shared/translation/nativePdf';

interface FormattedBlockActionsProps {
  /** The block is currently left as written. */
  kept: boolean;
  /** The block differs from what is on the page. */
  edited: boolean;
  /** A request for this block is in flight. */
  busy: boolean;
  /** Nothing can be asked for, e.g. while another block is being changed. */
  disabled: boolean;
  /** Smaller buttons, for the toolbar that floats over the page. */
  compact?: boolean;
  onShorten: () => void;
  onChange: (instruction: string) => void;
  onTranslate: () => void;
  onKeep: () => void;
  onRestore: () => void;
  onDone?: () => void;
}

/**
 * What can be done to one text block besides typing in it: a shorter
 * wording, a change described in words, leaving it as written (or
 * translating it if it was left), and going back to what is on the page.
 */
export function FormattedBlockActions({
  kept,
  edited,
  busy,
  disabled,
  compact,
  onShorten,
  onChange,
  onTranslate,
  onKeep,
  onRestore,
  onDone,
}: FormattedBlockActionsProps) {
  const t = useTranslations('workflows');
  const [asking, setAsking] = useState(false);
  const [instruction, setInstruction] = useState('');
  const button = `rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated ${
    compact ? 'px-2 py-1 text-[11px]' : 'min-h-[32px] px-2.5 py-1 text-xs'
  }`;
  const submit = () => {
    const text = instruction.trim();
    if (!text) return;
    onChange(text);
    setInstruction('');
    setAsking(false);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {kept ? (
          <button
            type="button"
            className={button}
            disabled={disabled}
            onClick={onTranslate}
          >
            {t('translation.formatted.translateBlock')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={onShorten}
            >
              {t('translation.formatted.shorten')}
            </button>
            <button
              type="button"
              className={button}
              disabled={disabled}
              aria-expanded={asking}
              onClick={() => setAsking((open) => !open)}
            >
              {t('translation.formatted.ask')}
            </button>
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={onKeep}
            >
              {t('translation.formatted.keep')}
            </button>
          </>
        )}
        {busy && (
          <span
            role="status"
            className="text-xs text-gray-500 dark:text-gray-400"
          >
            {t('translation.formatted.working')}
          </span>
        )}
        {edited && (
          <button
            type="button"
            disabled={disabled}
            onClick={onRestore}
            className={`ms-auto text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300 ${
              compact ? 'text-[11px]' : 'text-xs'
            }`}
          >
            {t('translation.formatted.restore')}
          </button>
        )}
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className={`rounded-lg bg-blue-600 font-semibold text-white hover:bg-blue-700 ${
              edited ? '' : 'ms-auto'
            } ${compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1 text-xs'}`}
          >
            {t('translation.formatted.done')}
          </button>
        )}
      </div>
      {asking && !kept && (
        <div className="flex gap-2">
          <input
            type="text"
            autoFocus
            value={instruction}
            maxLength={MAX_STEP_INSTRUCTION_CHARS}
            aria-label={t('translation.formatted.askPlaceholder')}
            placeholder={t('translation.formatted.askPlaceholder')}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            className="min-h-[32px] min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-surface-dark-base dark:text-gray-100"
          />
          <button
            type="button"
            className={button}
            disabled={disabled || !instruction.trim()}
            onClick={submit}
          >
            {t('translation.formatted.askApply')}
          </button>
        </div>
      )}
    </div>
  );
}
