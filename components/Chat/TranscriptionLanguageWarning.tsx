'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { useId, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  TranscriptionLanguageMetadata,
  getTranscriptionLanguageByCode,
} from '@/lib/constants/transcriptionLanguages';

/** Caution lives outside the transcript, including when it is collapsed or translated. */
export function TranscriptionLanguageWarning({
  metadata,
  id,
  result = false,
  compact = false,
}: {
  metadata?: TranscriptionLanguageMetadata;
  id?: string;
  result?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const disclosureId = useId();
  if (!metadata || metadata.officiallySupported) return null;
  const config = getTranscriptionLanguageByCode(metadata.language);
  const language = config ? t(config.labelKey) : metadata.language;
  const warning = t('transcription.unsupportedLanguageWarning', { language });
  const title = t(
    result
      ? 'transcription.experimentalTranscriptTitle'
      : 'transcription.unsupportedLanguageTitle',
  );

  if (compact) {
    return (
      <div
        id={id}
        className="min-w-0 max-w-full text-xs text-amber-950 dark:text-amber-100"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && expanded) {
            event.stopPropagation();
            setExpanded(false);
          }
        }}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={disclosureId}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-11 min-w-11 max-w-full items-center gap-1 rounded-sm bg-amber-100 px-2 py-1 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-950 dark:bg-amber-950 dark:focus-visible:outline-amber-100"
        >
          <IconAlertTriangle
            size={14}
            aria-hidden="true"
            className="shrink-0"
          />
          <span>{title}</span>
        </button>
        <p
          id={disclosureId}
          hidden={!expanded}
          className="mt-1 w-72 max-w-full whitespace-normal break-words rounded-md border border-amber-200 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950"
        >
          {warning}
        </p>
      </div>
    );
  }

  return (
    <div
      id={id}
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <IconAlertTriangle size={16} aria-hidden="true" className="shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p>{warning}</p>
      </div>
    </div>
  );
}
