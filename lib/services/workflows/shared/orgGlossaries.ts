import { resolveSlotGuide } from '@/lib/services/workflows/shared/guideResolution';

import { MAX_ORG_GLOSSARIES_PER_REQUEST } from '@/lib/utils/shared/review/guideCriteria';

import { GlossaryEntry } from '@/types/workflow';

/**
 * Organization-glossary attachment shared by the translate and assess
 * routes: which guide ids a request names, and their entries resolved
 * fail-closed in request order (the first guide wins on duplicate source
 * terms once merged — mergeGlossaryEntries keeps the earliest occurrence).
 */

const GUIDE_ID_PATTERN = /^guide-[a-f0-9]{12}$/;

/**
 * The guide ids a request attaches: `glossaryGuideIds`, falling back to the
 * legacy single `glossaryGuideId`. Deduped, order-preserving, shape-checked
 * (a malformed id is dropped — the resolver would refuse it anyway). Null
 * when more than the per-request cap are named: that is a client bug, not
 * an entitlement question, so it is reported rather than silently trimmed.
 */
export function requestedGuideIds(body: {
  glossaryGuideIds?: unknown;
  glossaryGuideId?: unknown;
}): string[] | null {
  const raw: unknown[] = Array.isArray(body.glossaryGuideIds)
    ? body.glossaryGuideIds
    : typeof body.glossaryGuideId === 'string' && body.glossaryGuideId
      ? [body.glossaryGuideId]
      : [];
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!GUIDE_ID_PATTERN.test(id) || ids.includes(id)) continue;
    ids.push(id);
  }
  if (ids.length > MAX_ORG_GLOSSARIES_PER_REQUEST) return null;
  return ids;
}

/**
 * Resolves every requested organization glossary. Any failure (unknown,
 * denied, wrong kind, payload missing) fails the whole request with the
 * resolver's generic message — the same contract as a single attachment.
 */
export async function resolveOrgGlossaries(
  userMail: string | undefined,
  guideIds: string[],
): Promise<{ entries: GlossaryEntry[] } | { error: string }> {
  const entries: GlossaryEntry[] = [];
  for (const guideId of guideIds) {
    const resolved = await resolveSlotGuide({
      userMail,
      guideId,
      expectedKind: 'terminology',
      workflow: 'translation',
    });
    if ('error' in resolved) return { error: resolved.error };
    if (resolved.guide.payload.kind === 'terminology') {
      entries.push(...resolved.guide.payload.entries);
    }
  }
  return { entries };
}
