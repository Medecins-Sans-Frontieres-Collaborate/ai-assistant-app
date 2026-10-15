'use client';

import { IconAlertTriangle } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { Tooltip } from '@/components/UI/Tooltip';

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
      <Tooltip content={warning} position="top">
        <span
          title={warning}
          className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100"
        >
          {title}
        </span>
      </Tooltip>
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
