'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  decodeRecoveryCode,
  normalizeRecoveryCode,
} from '@/lib/utils/shared/backupCrypto/recoveryCode';

const CODE_CHARS = 56;
const GROUP_SIZE = 4;

/** `A-Z` minus the confusables the alphabet excludes, plus digits. */
const VALID_CHARS = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]*$/;

type Feedback = 'empty' | 'incomplete' | 'format' | 'checksum' | 'valid';

/** Dash-group a normalized code for display: `Q7F3M2A9…` → `Q7F3-M2A9-…`. */
function formatGroups(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += GROUP_SIZE) {
    groups.push(normalized.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

export interface RecoveryCodeInputProps {
  /** Called with the decoded 32-byte master key when the user submits. */
  onSubmit: (key: Uint8Array) => void | Promise<void>;
  submitLabel: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /**
   * Error from the parent flow (e.g. "valid key but wrong backup") shown in
   * place of the local feedback. Cleared implicitly when the user edits.
   */
  externalError?: string | null;
  /** Notifies the parent that the user edited the code (clear externalError). */
  onEdit?: () => void;
}

/**
 * Paste-friendly single input for the 56-char recovery code. Normalizes as
 * the user types (uppercase, O→0, I/L→1, auto dash-grouping) and gives live
 * local checksum feedback before any network call. Submit is only enabled
 * once the checksum verifies.
 */
export function RecoveryCodeInput({
  onSubmit,
  submitLabel,
  disabled = false,
  autoFocus = false,
  externalError = null,
  onEdit,
}: RecoveryCodeInputProps) {
  const t = useTranslations('backup');
  const feedbackId = useId();
  const [value, setValue] = useState('');
  const [feedback, setFeedback] = useState<Feedback>('empty');
  const [validKey, setValidKey] = useState<Uint8Array | null>(null);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      // Normalize but DON'T strip genuinely invalid characters — the user
      // must see (and be told about) what they actually typed.
      const normalized = normalizeRecoveryCode(event.target.value).slice(
        0,
        CODE_CHARS,
      );
      setValue(formatGroups(normalized));
      onEdit?.();
    },
    [onEdit],
  );

  // Live validation: decodeRecoveryCode is async (SHA-256 checksum), so run
  // it in an effect with a cancellation guard against out-of-order results.
  useEffect(() => {
    const normalized = normalizeRecoveryCode(value);
    if (normalized.length === 0) {
      setFeedback('empty');
      setValidKey(null);
      return;
    }
    if (!VALID_CHARS.test(normalized)) {
      setFeedback('format');
      setValidKey(null);
      return;
    }
    if (normalized.length < CODE_CHARS) {
      setFeedback('incomplete');
      setValidKey(null);
      return;
    }
    let cancelled = false;
    void decodeRecoveryCode(normalized).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setFeedback('valid');
        setValidKey(result.key);
      } else {
        setFeedback(result.error === 'format' ? 'format' : 'checksum');
        setValidKey(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const isError =
    externalError !== null || feedback === 'checksum' || feedback === 'format';

  const feedbackText =
    externalError ??
    (feedback === 'checksum'
      ? t('input.checksumError')
      : feedback === 'format'
        ? t('input.formatError')
        : feedback === 'incomplete'
          ? t('input.incomplete')
          : feedback === 'valid'
            ? t('input.valid')
            : '');

  const canSubmit = validKey !== null && !disabled && externalError === null;

  const handleSubmit = useCallback(() => {
    if (validKey === null) return;
    void onSubmit(validKey);
  }, [validKey, onSubmit]);

  return (
    <div>
      <label
        htmlFor={`${feedbackId}-input`}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {t('input.label')}
      </label>
      <input
        id={`${feedbackId}-input`}
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="characters"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        value={value}
        onChange={handleChange}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && canSubmit) {
            event.preventDefault();
            handleSubmit();
          }
        }}
        placeholder={t('input.placeholder')}
        aria-invalid={isError}
        aria-describedby={feedbackId}
        className={`w-full rounded-lg border px-3 py-2 font-mono text-sm tracking-wide bg-white dark:bg-surface-dark-base text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 ${
          isError
            ? 'border-red-500 focus:ring-red-400'
            : 'border-gray-300 dark:border-gray-600 focus:ring-blue-400'
        }`}
      />
      <div
        id={feedbackId}
        aria-live="polite"
        className={`mt-1 min-h-[1.25rem] text-xs ${
          isError
            ? 'text-red-600 dark:text-red-400'
            : feedback === 'valid'
              ? 'text-green-600 dark:text-green-400'
              : 'text-gray-500 dark:text-gray-400'
        }`}
      >
        {feedbackText}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('input.hint')}
      </p>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="mt-4 w-full px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitLabel}
      </button>
    </div>
  );
}
