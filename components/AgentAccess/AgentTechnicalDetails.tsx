'use client';

import { FC, ReactNode } from 'react';

import { useTranslations } from 'next-intl';

import { CanonicalKeyChip } from './CanonicalKeyChip';

interface AgentTechnicalDetailsProps {
  canonicalKey: string;
  source?: string;
  /** Provider-specific metadata and audit information, hidden at rest. */
  children?: ReactNode;
}

/** Keeps full, copyable identifiers and diagnostic metadata out of the scan path. */
export const AgentTechnicalDetails: FC<AgentTechnicalDetailsProps> = ({
  canonicalKey,
  source,
  children,
}) => {
  const tAccess = useTranslations('agentAccess');
  const tCopy = useTranslations('transcript');

  return (
    <details className="mt-1 min-w-0 text-xs text-gray-600 dark:text-gray-300">
      <summary className="min-h-8 w-fit cursor-pointer rounded-md py-1.5 focus-visible:outline focus-visible:outline-2 [@media(pointer:coarse)]:min-h-11">
        {tAccess('detailsLabel')}
      </summary>
      <div className="flex min-w-0 flex-col items-start gap-2 pt-1">
        {source && (
          <CanonicalKeyChip
            canonicalKey={source}
            label={tAccess('sourceLabel')}
            copyLabel={`${tCopy('copy')} (${tAccess('sourceLabel')})`}
            wrap
          />
        )}
        <CanonicalKeyChip canonicalKey={canonicalKey} wrap />
        {children}
      </div>
    </details>
  );
};
