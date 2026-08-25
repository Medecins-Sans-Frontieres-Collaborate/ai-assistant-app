'use client';

import { IconCheck, IconCopy } from '@tabler/icons-react';
import { FC, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

interface CanonicalKeyChipProps {
  canonicalKey: string;
  /** Extra label before the key ("Key" by default). */
  label?: string;
}

/**
 * The one place an admin can read — and copy — an agent's canonical key
 * (`<source>::<id>`): what delegation, view-as and the access rules are
 * all keyed by. Monospace, truncated with the full value on hover.
 */
export const CanonicalKeyChip: FC<CanonicalKeyChipProps> = ({
  canonicalKey,
  label,
}) => {
  const t = useTranslations('agentAccess');
  const [copied, setCopied] = useState(false);

  const codeRef = useRef<HTMLElement>(null);

  /** Selects the key text so the admin can copy it by hand. */
  const selectKey = () => {
    const node = codeRef.current;
    if (!node || typeof window === 'undefined') return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const copy = async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        selectKey();
        return;
      }
      await navigator.clipboard.writeText(canonicalKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (insecure context, permissions): fall back to a
      // selection — and never claim success.
      selectKey();
    }
  };

  return (
    <span className="inline-flex max-w-full items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
      <span className="shrink-0">{label ?? t('canonicalKeyLabel')}:</span>
      <code
        ref={codeRef}
        className="min-w-0 truncate rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] text-gray-700 dark:bg-gray-800 dark:text-gray-300"
        title={canonicalKey}
      >
        {canonicalKey}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t('copyKey')}
        title={t('copyKey')}
        className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      >
        {copied ? (
          <IconCheck size={12} className="text-green-600" />
        ) : (
          <IconCopy size={12} />
        )}
      </button>
    </span>
  );
};
