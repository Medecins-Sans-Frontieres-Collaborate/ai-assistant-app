import { BRIEF_ITSELF } from '@/lib/utils/shared/drafter/core/grounding';

import { Brief } from '@/types/drafter';

/** The translator shape the labels need; next-intl's `t` fits it. */
type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * A sentence resting on the brief's own fields rather than on an item.
 * BRIEF_ITSELF (what the grounding layer and older verdicts emit) reads as
 * the key message; the call to action has its own id so the two are told
 * apart in superscripts and in the brief pane.
 */
export const KEY_MESSAGE_REF = BRIEF_ITSELF;
export const CALL_TO_ACTION_REF = '__cta__';

export function isBriefRef(itemId: string): boolean {
  return itemId === KEY_MESSAGE_REF || itemId === CALL_TO_ACTION_REF;
}

/**
 * Each item's 1-based position in the brief. Every item counts, included or
 * not, so a number keeps naming the same row when one is excluded.
 */
export function itemRefs(brief: Brief): Map<string, number> {
  return new Map(brief.items.map((item, index) => [item.id, index + 1]));
}

/**
 * '#3 Fact', or 'the key message' / 'the call to action' for the brief's
 * own fields; '' for an id the brief no longer holds.
 */
export function refLabel(t: Translate, brief: Brief, itemId: string): string {
  if (itemId === KEY_MESSAGE_REF) return t('refKeyMessageName');
  if (itemId === CALL_TO_ACTION_REF) return t('refCallToActionName');
  const n = itemRefs(brief).get(itemId);
  const item = brief.items.find((entry) => entry.id === itemId);
  if (n === undefined || !item) return '';
  return t('itemRefLabel', { kind: t(`kinds.${item.kind}`), n });
}

/** The labels of several ids, joined; unknown ids are skipped. */
export function refNames(
  t: Translate,
  brief: Brief,
  itemIds: string[],
): string {
  return itemIds
    .map((id) => refLabel(t, brief, id))
    .filter(Boolean)
    .join(', ');
}

/**
 * What a superscript shows: '2' | '2,5' | 'KM' | 'CTA,3'. Unknown ids are
 * skipped, so a deleted item never leaves a blank.
 */
export function refTags(t: Translate, brief: Brief, itemIds: string[]): string {
  const refs = itemRefs(brief);
  const tags: string[] = [];
  for (const id of itemIds) {
    const tag =
      id === KEY_MESSAGE_REF
        ? t('refKeyMessage')
        : id === CALL_TO_ACTION_REF
          ? t('refCallToAction')
          : refs.get(id)?.toString();
    if (tag !== undefined && !tags.includes(tag)) tags.push(tag);
  }
  return tags.join(',');
}
