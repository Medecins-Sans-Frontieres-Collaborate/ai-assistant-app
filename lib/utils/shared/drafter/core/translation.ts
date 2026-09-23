/**
 * A draft in another language is a NEW draft set written from a translated
 * brief, not a second axis on this one: one kind of version per
 * conversation stays true, and the trust model carries over unchanged.
 *
 * The human reviews each translated quotation once (items arrive undecided),
 * every translated item keeps its original words as proof, and from then on
 * the usual checks hold the posts to the translated words that were
 * approved. Code guards the one thing a translation must never change: the
 * numbers.
 */
import {
  DraftSetState,
  TranslateBriefResponse,
  Version,
} from '@/types/drafter';

import { numbersSupported } from './grounding';

/** Every number in the translation is a number of the original. */
export function numbersPreserved(
  original: string,
  translated: string,
): boolean {
  return numbersSupported(translated, original);
}

/**
 * The state of the new draft: same sources, channels, voices, links and
 * arrangement; the brief translated; nothing written yet.
 *
 * An item keeps the verification its original earned, with one exception: a
 * translation that changed a number is marked "Not found", so it cannot be
 * included until the user has looked at it.
 */
export function translatedDraftState<S extends DraftSetState>(
  state: S,
  translation: TranslateBriefResponse,
  targetLanguage: string,
  now: string,
): S {
  const byId = new Map(translation.items.map((item) => [item.id, item]));
  const sourceLanguage = state.brief.language || 'English';

  const items = state.brief.items
    // What the user left out of the original is not carried over.
    .filter((item) => item.decision !== 'excluded')
    .flatMap((item) => {
      const translated = byId.get(item.id);
      if (!translated?.text.trim()) return [];
      const safe = translated.numbersPreserved;
      return [
        {
          ...item,
          text: translated.text.trim(),
          attribution: item.attribution
            ? {
                // A name is never translated; a role is.
                name: item.attribution.name,
                role: translated.role?.trim() || item.attribution.role,
              }
            : undefined,
          original: item.original ?? {
            text: item.text,
            language: sourceLanguage,
          },
          verified: safe ? item.verified : ('unverified' as const),
          // Asked again: these are new words, even when the old ones were in.
          decision: undefined,
        },
      ];
    });

  const versions: Record<string, Version> = {};
  for (const specId of state.specIds) {
    const toneRef = state.versions[specId]?.toneRef;
    versions[specId] = {
      specId,
      segments: [],
      briefRev: 0,
      briefDigest: '',
      handEdited: false,
      history: [],
      ...(toneRef ? { toneRef } : {}),
    };
  }

  return {
    ...state,
    updatedAt: now,
    brief: {
      ...state.brief,
      rev: 0,
      keyMessage: translation.keyMessage.trim() || state.brief.keyMessage,
      callToAction:
        translation.callToAction?.trim() || state.brief.callToAction,
      language: targetLanguage,
      items,
    },
    versions,
  };
}
