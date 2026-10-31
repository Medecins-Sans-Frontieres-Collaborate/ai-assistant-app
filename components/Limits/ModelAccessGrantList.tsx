'use client';

import { IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import { lookupEntraGroups } from '@/client/services/m365/m365Client';
import type { ModelAccessGrant } from '@/lib/services/limits/types';

import {
  ADMIN_BTN_ICON_DANGER,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { ChipListInput } from '@/components/AgentAccess/ChipListInput';
import { GroupSearchPicker } from '@/components/AgentAccess/GroupSearchPicker';
import { normalizeDomainEntry } from '@/components/AgentAccess/RuleEditor';

export type GrantListKind = 'groups' | 'domains' | 'allow';

interface ModelAccessGrantListProps {
  kind: GrantListKind;
  grants: ModelAccessGrant[];
  onChange: (grants: ModelAccessGrant[]) => void;
  disabled?: boolean;
}

/**
 * One access list of a model approval node: each target with its own terms
 * (unlimited, or N requests per day), plus an adder. The adder reuses the
 * shared pickers with an EMPTY value list — they render no chips of their
 * own and simply hand back what was added — so the rows below can carry the
 * per-target terms control the chip inputs have no room for.
 */
export const ModelAccessGrantList: FC<ModelAccessGrantListProps> = ({
  kind,
  grants,
  onChange,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();

  // Group grants persist Entra object ids; show their names like the group
  // picker's chips do, falling back to the id while (or if) the lookup does
  // not answer.
  const groupIds = kind === 'groups' ? grants.map((g) => g.target) : [];
  const groupNames = useQuery({
    queryKey: ['model-access-group-names', ...groupIds],
    queryFn: () => lookupEntraGroups(groupIds),
    enabled: groupIds.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });
  const labelFor = (target: string) => {
    const name = groupNames.data?.find((g) => g.id === target)?.name;
    return name ? (
      <>
        {name} <span className={ADMIN_MUTED}>({target.slice(0, 8)}…)</span>
      </>
    ) : (
      target
    );
  };

  const add = (added: string[]) => {
    const have = new Set(grants.map((g) => g.target.toLowerCase()));
    const fresh = added
      .map((value) => value.trim())
      .filter((value) => value && !have.has(value.toLowerCase()))
      .map((target) => ({ target, requests: null }));
    if (fresh.length) onChange([...grants, ...fresh]);
  };
  const setRequests = (index: number, requests: number | null) =>
    onChange(grants.map((g, i) => (i === index ? { ...g, requests } : g)));
  const remove = (index: number) =>
    onChange(grants.filter((_, i) => i !== index));

  return (
    <div>
      <div className={ADMIN_LABEL}>
        {t(`modelAccess.list.${kind}` as never)}
      </div>
      <p className={ADMIN_HINT}>{t(`modelAccess.listHint.${kind}` as never)}</p>
      {grants.length > 0 && (
        <ul className="mb-2 space-y-1">
          {grants.map((grant, index) => (
            <li
              key={grant.target}
              className="flex flex-wrap items-center gap-2 text-sm text-black dark:text-white"
            >
              <span className="min-w-[160px] flex-1 break-all">
                {labelFor(grant.target)}
              </span>
              <select
                className={ADMIN_FIELD}
                value={grant.requests === null ? 'unlimited' : 'limited'}
                onChange={(e) =>
                  setRequests(
                    index,
                    e.target.value === 'unlimited'
                      ? null
                      : typeof grant.requests === 'number'
                        ? grant.requests
                        : 10,
                  )
                }
                disabled={disabled}
                aria-label={t('modelAccess.termsLabel', {
                  target: grant.target,
                })}
              >
                <option value="unlimited">
                  {t('modelAccess.grantUnlimited')}
                </option>
                <option value="limited">{t('modelAccess.grantLimited')}</option>
              </select>
              {grant.requests !== null && (
                <span className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    className={`w-24 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none ${ADMIN_FIELD}`}
                    value={grant.requests}
                    onChange={(e) => {
                      const parsed = Number.parseInt(e.target.value, 10);
                      setRequests(
                        index,
                        Number.isNaN(parsed) ? 1 : Math.max(1, parsed),
                      );
                    }}
                    disabled={disabled}
                    aria-label={t('modelAccess.requestsLabel', {
                      target: grant.target,
                    })}
                  />
                  <span className={ADMIN_MUTED}>
                    {t('modelAccess.requestsPerDay')}
                  </span>
                </span>
              )}
              <button
                type="button"
                className={ADMIN_BTN_ICON_DANGER}
                onClick={() => remove(index)}
                disabled={disabled}
                aria-label={t('modelAccess.removeGrant', {
                  target: grant.target,
                })}
              >
                <IconTrash size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {kind === 'groups' ? (
        <GroupSearchPicker
          values={[]}
          onChange={add}
          labels={{
            searchPlaceholder: t('groupSearchPlaceholder'),
            searchHint: t('groupSearchHint'),
            noResults: t('groupSearchNoResults'),
            searchError: t('groupSearchError'),
            chipPlaceholder: t('targetsPlaceholder.group'),
            addHint: t('chipAddHint'),
            removeLabel: t('removeChip'),
            flagOffHint: t('groupsFlagOff'),
          }}
          disabled={disabled}
        />
      ) : (
        <ChipListInput
          values={[]}
          onChange={add}
          normalize={kind === 'domains' ? normalizeDomainEntry : undefined}
          placeholder={t(
            kind === 'domains'
              ? 'targetsPlaceholder.domain'
              : 'targetsPlaceholder.user',
          )}
          addHint={t('chipAddHint')}
          removeLabel={t('removeChip')}
          disabled={disabled}
          suggest={kind === 'allow' ? peopleSuggest : undefined}
          suggestionsLabel={tPeople('listLabel')}
        />
      )}
    </div>
  );
};
