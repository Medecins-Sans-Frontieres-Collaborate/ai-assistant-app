'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { RuleEffect, directionOf } from '@/lib/services/limits/policyChanges';

import {
  DirectionMark,
  useFormatLimitValue,
} from '@/components/Limits/visualSyntax';

import { LimitDefinition } from '@/config/limits';

/**
 * One sentence saying what a rule entry does for a member of its audience:
 * the value they get and what they would get without it, or why it has no
 * effect as set (a hard ceiling, a higher-ranked rule, or the rule or its
 * delegation is off). Computed by the real resolver (policyChanges.ruleEffect).
 */
export const RuleEffectLine: FC<{
  effect: RuleEffect;
  def: LimitDefinition;
}> = ({ effect, def }) => {
  const t = useTranslations('limits');
  const format = useFormatLimitValue();
  const now = effect.withRule.resolved.value;
  const before = effect.otherwise.resolved.value;
  const value = format(now, def).text;
  const otherwise = format(before, def).text;

  if (effect.status === 'inert') {
    return (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('console.effect.inert')}
      </p>
    );
  }
  if (effect.status === 'held-by-ceiling') {
    return (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        <strong>{t('console.effect.noEffect')}</strong>{' '}
        {t('console.effect.heldByCeiling', { value })}
      </p>
    );
  }
  if (effect.status === 'outranked') {
    return (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        <strong>{t('console.effect.noEffect')}</strong>{' '}
        {t('console.effect.outranked', { value })}
      </p>
    );
  }
  const direction = directionOf(before, now);
  const removesCap = now === null && before !== null;
  return (
    <p className="text-sm text-gray-700 dark:text-gray-300">
      <DirectionMark direction={removesCap ? 'removes-cap' : direction} />{' '}
      {direction === 'same'
        ? t('console.effect.same', { value })
        : t('console.effect.applies', { value, otherwise })}
    </p>
  );
};
