'use client';

import { IconPlus, IconTrash } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { JurisdictionPredicate } from '@/lib/services/limits/types';

import {
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_SECONDARY,
  ADMIN_FIELD,
  ADMIN_HINT,
} from '@/components/Admin/adminClasses';

const SCOPES: JurisdictionPredicate['scope'][] = [
  'domain',
  'user',
  'attribute',
  'group',
];

/** Targets are edited as one-per-line text; canonicalized by the server. */
export function targetsToText(targets: readonly string[]): string {
  return targets.join('\n');
}

export function textToTargets(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((target) => target.trim())
    .filter(Boolean);
}

export interface PredicateDraft {
  scope: JurisdictionPredicate['scope'];
  /** Raw text, so typing a separator does not fight the cursor. */
  text: string;
}

interface PredicateListEditorProps {
  predicates: PredicateDraft[];
  onChange: (next: PredicateDraft[]) => void;
  disabled?: boolean;
  idPrefix: string;
}

/**
 * OR'd `{scope, targets}` predicates — the one targeting vocabulary shared by
 * limits overrides, delegation jurisdictions and announcement audiences
 * (`matchesPrincipal`).
 */
export const PredicateListEditor: FC<PredicateListEditorProps> = ({
  predicates,
  onChange,
  disabled = false,
  idPrefix,
}) => {
  const t = useTranslations('delegationsAdmin');
  const update = (index: number, patch: Partial<PredicateDraft>) =>
    onChange(
      predicates.map((predicate, i) =>
        i === index ? { ...predicate, ...patch } : predicate,
      ),
    );

  return (
    <div className="space-y-2">
      {predicates.map((predicate, index) => (
        <div key={index} className="flex items-start gap-2">
          <select
            aria-label={t('predicateScope')}
            className={`${ADMIN_FIELD} w-36 shrink-0`}
            value={predicate.scope}
            disabled={disabled}
            onChange={(e) =>
              update(index, {
                scope: e.target.value as JurisdictionPredicate['scope'],
              })
            }
          >
            {SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {t(`scope.${scope}`)}
              </option>
            ))}
          </select>
          <div className="min-w-0 flex-1">
            <textarea
              id={`${idPrefix}-targets-${index}`}
              aria-label={t('predicateTargets')}
              className={`${ADMIN_FIELD} w-full font-mono text-xs`}
              rows={2}
              value={predicate.text}
              disabled={disabled}
              placeholder={t(`scopePlaceholder.${predicate.scope}`)}
              onChange={(e) => update(index, { text: e.target.value })}
            />
          </div>
          <button
            type="button"
            className={ADMIN_BTN_ICON_DANGER}
            aria-label={t('removePredicate')}
            disabled={disabled}
            onClick={() => onChange(predicates.filter((_, i) => i !== index))}
          >
            <IconTrash size={16} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={ADMIN_BTN_SECONDARY}
        disabled={disabled}
        onClick={() => onChange([...predicates, { scope: 'domain', text: '' }])}
      >
        <IconPlus size={16} />
        {t('addPredicate')}
      </button>
      <p className={ADMIN_HINT}>{t('predicateHint')}</p>
    </div>
  );
};
