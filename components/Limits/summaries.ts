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
  groupNames?: Record<string, string>,
): string {
  const scopeLabel = t(`scope.${scope}`);
  if (targets.length === 0) {
    return t('appliesTo', {
      scope: scopeLabel,
      targets: t('appliesToNone'),
    });
  }
  // Group ids mean nothing to a reader: show the resolved name when one is
  // known (policy labels or the shared client cache), the id otherwise.
  const display =
    scope === 'group' && groupNames
      ? targets.map((id) => groupNames[id] ?? id)
      : targets;
  const { shown, more } = summarizeTargets(display);
  const list =
    more > 0
      ? t('appliesToMore', { targets: shown.join(', '), more })
      : shown.join(', ');
  return t('appliesTo', { scope: scopeLabel, targets: list });
}

/**
 * Jurisdiction in one line, buckets joined by " · ": domains, users and
 * attributes are listed (truncated); groups are listed when every id has a
 * known display name and counted otherwise — GUID prefixes mean nothing
 * to a reader.
 */
export function jurisdictionLine(
  t: LimitsTranslate,
  predicates: readonly JurisdictionPredicate[],
  groupNames?: Record<string, string>,
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
    // Named groups are listed like domains; with no names at all the count
    // is more honest than a row of GUID prefixes.
    const named = groupNames ? summary.groups.map((id) => groupNames[id]) : [];
    if (named.length > 0 && named.every((name) => !!name)) {
      listed('group', named as string[]);
    } else {
      parts.push(
        t('appliesTo', {
          scope: t('scope.group'),
          targets: t('jurisdictionGroupCount', {
            count: summary.groups.length,
          }),
        }),
      );
    }
  }
  listed('attribute', summary.attributes);
  return parts.length > 0 ? parts.join(' · ') : t('jurisdictionMatchesNobody');
}
