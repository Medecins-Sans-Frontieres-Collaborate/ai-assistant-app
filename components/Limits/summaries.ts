/**
 * One-line summaries the limits panel repeats on many cards — "applies to
 * <scope>: a, b and 3 more" on an override, "Email domain: ocp.msf.org ·
 * Specific people: 2" on a delegation. Kept in one place so the two surfaces
 * (global Overrides tab, scoped mode) cannot drift.
 *
 * Takes the `useTranslations('limits')` function rather than key strings so
 * the caller's namespace typing survives. Messages are untyped in this app
 * (`Record<string, any>`), so the translator accepts any string key and the
 * helpers can build keys freely.
 */
import {
  JurisdictionPredicate,
  OverrideScope,
} from '@/lib/services/limits/types';

import {
  summarizeJurisdiction,
  summarizeTargets,
} from '@/components/Limits/jurisdiction';

export type LimitsTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** `appliesTo` copy: "<scope label>: t1, t2, t3 and N more" (or "no targets yet"). */
export function appliesToLine(
  t: LimitsTranslate,
  scope: OverrideScope,
  targets: readonly string[],
): string {
  const scopeLabel = t(`scope.${scope}`);
  if (targets.length === 0) {
    return t('appliesTo', {
      scope: scopeLabel,
      targets: t('appliesToNone'),
    });
  }
  const { shown, more } = summarizeTargets(targets);
  const list =
    more > 0
      ? t('appliesToMore', { targets: shown.join(', '), more })
      : shown.join(', ');
  return t('appliesTo', { scope: scopeLabel, targets: list });
}

/**
 * Jurisdiction in one line, buckets joined by " · ": domains and users are
 * listed (truncated), groups and attributes are counted — group ids mean
 * nothing to a reader and attribute lists get long.
 */
export function jurisdictionLine(
  t: LimitsTranslate,
  predicates: readonly JurisdictionPredicate[],
): string {
  const summary = summarizeJurisdiction(predicates);
  const parts: string[] = [];
  const listed = (scope: OverrideScope, values: string[]) => {
    if (values.length === 0) return;
    const { shown, more } = summarizeTargets(values);
    const list =
      more > 0
        ? t('appliesToMore', { targets: shown.join(', '), more })
        : shown.join(', ');
    parts.push(
      t('appliesTo', {
        scope: t(`scope.${scope}`),
        targets: list,
      }),
    );
  };
  listed('domain', summary.domains);
  listed('user', summary.users);
  if (summary.groups.length > 0) {
    parts.push(
      t('appliesTo', {
        scope: t('scope.group'),
        targets: t('jurisdictionGroupCount', {
          count: summary.groups.length,
        }),
      }),
    );
  }
  listed('attribute', summary.attributes);
  return parts.length > 0 ? parts.join(' · ') : t('jurisdictionMatchesNobody');
}
