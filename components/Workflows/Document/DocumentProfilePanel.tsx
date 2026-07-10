'use client';

import { useTranslations } from 'next-intl';

import { DocumentProfile } from '@/types/workflow';

interface DocumentProfilePanelProps {
  profile: DocumentProfile;
}

/**
 * Read-only strip showing the agentic pre-assessment of the document:
 * what it is, who it's for, register, tone, and spelling variety.
 */
export function DocumentProfilePanel({ profile }: DocumentProfilePanelProps) {
  const t = useTranslations('workflows.document');

  const items: Array<[string, string | undefined]> = [
    [t('profileDocType'), profile.docType],
    [t('profileLanguage'), profile.language],
    [t('profileAudience'), profile.audience],
    [t('profilePurpose'), profile.purpose],
    [t('profileRegister'), profile.register],
    [t('profileTone'), profile.toneSummary],
    [t('profileConventions'), profile.conventionNotes],
  ];

  return (
    <div className="border-t border-gray-200 px-4 py-2.5 dark:border-gray-700">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('profileTitle')}
      </h3>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {items
          .filter((entry): entry is [string, string] => !!entry[1]?.trim())
          .map(([label, value]) => (
            <span key={label} className="text-gray-700 dark:text-gray-300">
              <span className="text-gray-500 dark:text-gray-400">
                {label}:{' '}
              </span>
              {value}
            </span>
          ))}
      </div>
      {profile.notes && (
        <p className="mt-1 max-w-[75ch] text-xs text-gray-500 dark:text-gray-400">
          {profile.notes}
        </p>
      )}
    </div>
  );
}
