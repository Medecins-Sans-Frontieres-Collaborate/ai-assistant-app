'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import type {
  ModelAccessDefault,
  ModelAccessRule,
} from '@/lib/services/limits/types';

import {
  AccessState,
  EffectiveAccess,
  ModelAccessDimension,
  emptyRule,
} from '@/lib/utils/app/modelAccessTree';

import {
  ADMIN_CHIP_WARN,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { ChipListInput } from '@/components/AgentAccess/ChipListInput';
import { ModelAccessGrantList } from '@/components/Limits/ModelAccessGrantList';

interface ModelAccessNodeEditorProps {
  dimension: ModelAccessDimension;
  rule: ModelAccessRule | undefined;
  /** What everyone not on a list gets today, with where it comes from. */
  effective: EffectiveAccess;
  onChange: (next: ModelAccessRule) => void;
  /** The generic defaults editor also sets this cell — the PUT will refuse. */
  collision?: boolean;
  disabled?: boolean;
}

type DefaultMode = 'inherit' | 'unlimited' | 'limited' | 'unavailable';

function modeOf(value: ModelAccessDefault | undefined): DefaultMode {
  if (value === undefined) return 'inherit';
  if (value === false) return 'unavailable';
  if (value === null) return 'unlimited';
  return 'limited';
}

/** Pre-translated state line: "Unlimited" / "Limited to 50 / day" / "Unavailable". */
export function stateLabel(
  t: (key: string, values?: Record<string, string | number>) => string,
  state: AccessState,
): string {
  if (state.kind === 'limited') {
    return t('modelAccess.state.limited', { requests: state.requests });
  }
  return t(`modelAccess.state.${state.kind}`);
}

/**
 * The body of one node (family or model): the default for everyone else —
 * Inherit / Unlimited / Limited / Unavailable, with the inherited answer
 * spelled out — then the four lists.
 */
export const ModelAccessNodeEditor: FC<ModelAccessNodeEditorProps> = ({
  dimension,
  rule,
  effective,
  onChange,
  collision = false,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const current = rule ?? emptyRule(dimension);
  const mode = modeOf(current.defaultAccess);

  const update = (patch: Partial<ModelAccessRule>) =>
    onChange({ ...current, ...patch });

  const setMode = (next: DefaultMode) => {
    if (next === 'inherit') {
      const { defaultAccess: _dropped, ...rest } = current;
      onChange(rest);
      return;
    }
    if (next === 'unavailable') return update({ defaultAccess: false });
    if (next === 'unlimited') return update({ defaultAccess: null });
    update({
      defaultAccess:
        typeof current.defaultAccess === 'number' ? current.defaultAccess : 10,
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className={ADMIN_LABEL}>
          {t('modelAccess.defaultLabel')}
          <span className="ml-2 flex flex-wrap items-center gap-2">
            <select
              className={ADMIN_FIELD}
              value={mode}
              onChange={(e) => setMode(e.target.value as DefaultMode)}
              disabled={disabled}
            >
              <option value="inherit">{t('modelAccess.defaultInherit')}</option>
              <option value="unlimited">
                {t('modelAccess.defaultUnlimited')}
              </option>
              <option value="limited">{t('modelAccess.defaultLimited')}</option>
              <option value="unavailable">
                {t('modelAccess.defaultUnavailable')}
              </option>
            </select>
            {mode === 'limited' && (
              <span className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className={`w-24 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none ${ADMIN_FIELD}`}
                  value={
                    typeof current.defaultAccess === 'number'
                      ? current.defaultAccess
                      : ''
                  }
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    update({
                      defaultAccess: Number.isNaN(parsed)
                        ? 1
                        : Math.max(1, parsed),
                    });
                  }}
                  disabled={disabled}
                  aria-label={t('modelAccess.defaultRequestsLabel')}
                />
                <span className={ADMIN_MUTED}>
                  {t('modelAccess.requestsPerDay')}
                </span>
              </span>
            )}
          </span>
        </label>
        <p className={ADMIN_HINT}>
          {mode === 'inherit'
            ? t('modelAccess.inheritedFrom', {
                state: stateLabel(t, effective.state),
                origin: t(`modelAccess.origin.${effective.origin}` as never),
              })
            : t('modelAccess.effectiveLabel', {
                state: stateLabel(t, effective.state),
              })}
        </p>
        {collision && (
          <p className={ADMIN_HINT} role="alert">
            <span className={ADMIN_CHIP_WARN}>
              {t('modelAccess.collisionChip')}
            </span>{' '}
            {t('modelAccess.collisionWarning')}
          </p>
        )}
      </div>

      <ModelAccessGrantList
        kind="groups"
        grants={current.groups}
        onChange={(groups) => update({ groups })}
        disabled={disabled}
      />
      <ModelAccessGrantList
        kind="domains"
        grants={current.domains}
        onChange={(domains) => update({ domains })}
        disabled={disabled}
      />
      <ModelAccessGrantList
        kind="allow"
        grants={current.allow}
        onChange={(allow) => update({ allow })}
        disabled={disabled}
      />
      <div>
        <div className={ADMIN_LABEL}>{t('modelAccess.list.deny')}</div>
        <p className={ADMIN_HINT}>{t('modelAccess.listHint.deny')}</p>
        <ChipListInput
          values={current.deny}
          onChange={(deny) => update({ deny })}
          placeholder={t('targetsPlaceholder.user')}
          addHint={t('chipAddHint')}
          removeLabel={t('removeChip')}
          disabled={disabled}
          suggest={peopleSuggest}
          suggestionsLabel={tPeople('listLabel')}
          chipTone={() => 'danger'}
        />
      </div>
    </div>
  );
};
