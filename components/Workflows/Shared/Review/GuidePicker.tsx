'use client';

import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { AvailableGuide } from '@/client/hooks/settings/useAvailableGuides';

import { guideCriterionId } from '@/lib/utils/shared/review/guideCriteria';

interface GuidePickerProps {
  /** Criterion-kind guides for this workflow (caller filters kind+workflow). */
  guides: AvailableGuide[];
  /** Selected criterion ids (shared with the CriteriaPicker's set). */
  selected: Set<string>;
  onToggle: (criterionId: string) => void;
  /** e.g. 'workflows.document' — provides the section strings. */
  i18nNamespace: string;
  disabled?: boolean;
}

interface GuideBodyResponse {
  success: boolean;
  data?: { guide: { body: string } };
}

/**
 * Read-only body viewer, fetched lazily on first expand. Users may always
 * read the criteria they are being reviewed against — the body just never
 * travels with the assess request (the server resolves it by id).
 */
function GuideBody({ guideId }: { guideId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['guide-body', guideId],
    queryFn: async (): Promise<string> => {
      const response = await fetch(`/api/guides/${guideId}`);
      if (!response.ok) {
        throw new Error(`Failed to load guide: ${response.status}`);
      }
      const json: GuideBodyResponse = await response.json();
      return json.data?.guide.body ?? '';
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const t = useTranslations('workflows.shared');

  if (isLoading) {
    return (
      <p className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400">…</p>
    );
  }
  if (isError) {
    return (
      <p className="px-2 py-1 text-xs text-red-700 dark:text-red-400">
        {t('guideBodyFailed')}
      </p>
    );
  }
  return (
    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-gray-50 px-2 py-1.5 font-sans text-xs text-gray-700 dark:bg-surface-dark dark:text-gray-300">
      {data}
    </pre>
  );
}

/**
 * Admin-guide checkboxes for the quality review, sharing the criterion
 * selection set with the CriteriaPicker (guides select as `guide:<id>` ids).
 * Renders nothing when no guides are visible — the feature being off, the
 * user having access to none, and none existing all look identical here.
 */
export function GuidePicker({
  guides,
  selected,
  onToggle,
  i18nNamespace,
  disabled,
}: GuidePickerProps) {
  const t = useTranslations(i18nNamespace);
  const tShared = useTranslations('workflows.shared');
  const [openGuideId, setOpenGuideId] = useState<string | null>(null);

  if (guides.length === 0) return null;

  return (
    <fieldset
      className="flex w-full flex-col gap-1"
      disabled={disabled}
      data-testid="guide-picker"
    >
      <legend className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('guides')}
      </legend>
      {guides.map((guide) => {
        const criterionId = guideCriterionId(guide.id);
        const isOpen = openGuideId === guide.id;
        return (
          <div key={guide.id} className="flex flex-col">
            <span className="inline-flex min-h-[28px] items-center gap-1.5">
              <label
                className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300"
                title={guide.description || undefined}
              >
                <input
                  type="checkbox"
                  checked={selected.has(criterionId)}
                  onChange={() => onToggle(criterionId)}
                />
                {guide.name}
                <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-surface-dark-elevated dark:text-gray-400">
                  {tShared(`guideKind.${guide.kind}`)}
                </span>
              </label>
              <button
                type="button"
                onClick={() => setOpenGuideId(isOpen ? null : guide.id)}
                aria-expanded={isOpen}
                className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
              >
                {isOpen ? (
                  <IconChevronDown size={12} aria-hidden />
                ) : (
                  <IconChevronRight size={12} aria-hidden />
                )}
                {isOpen ? tShared('hideGuide') : tShared('viewGuide')}
              </button>
            </span>
            {isOpen && <GuideBody guideId={guide.id} />}
          </div>
        );
      })}
    </fieldset>
  );
}
