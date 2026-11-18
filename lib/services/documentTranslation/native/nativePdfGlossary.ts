import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import { mergeGlossaryEntries } from '@/lib/services/workflows/shared/glossaryPrompts';
import {
  requestedGuideIds,
  resolveOrgGlossaries,
} from '@/lib/services/workflows/shared/orgGlossaries';

import {
  MAX_GUIDE_ENTRIES,
  MAX_ORG_GLOSSARIES_PER_REQUEST,
} from '@/lib/utils/shared/review/guideCriteria';
import { sanitizeGlossaryEntry } from '@/lib/utils/shared/translation/glossaryMatch';

import { GlossaryEntry } from '@/types/workflow';

/** Merged (organization + personal) entries considered per request. */
const MAX_MERGED_ENTRIES =
  MAX_ORG_GLOSSARIES_PER_REQUEST * MAX_GUIDE_ENTRIES + MAX_GUIDE_ENTRIES;

/**
 * The glossary a native PDF request translates with: the personal entries
 * sent in the request merged with the organization glossaries it names.
 *
 * Same contract as the text translation route: entries are sanitized
 * because they become prompt text, organization glossaries resolve by id
 * and fail closed, and organization terms win on duplicates.
 *
 * @param req - The request, for the group-membership lookup.
 * @param session - The signed-in user.
 * @param body - `glossaryEntries` (personal entries) and `glossaryGuideIds`.
 * @returns The merged entries, or `error` with a message for a 400.
 */
export async function resolveRequestGlossary(
  req: NextRequest,
  session: Session,
  body: { glossaryEntries?: unknown; glossaryGuideIds?: unknown },
): Promise<{ entries: GlossaryEntry[] } | { error: string }> {
  const personal: GlossaryEntry[] = Array.isArray(body.glossaryEntries)
    ? body.glossaryEntries
        .map((entry: unknown) => sanitizeGlossaryEntry(entry))
        .filter((entry): entry is GlossaryEntry => entry !== null)
        .slice(0, MAX_GUIDE_ENTRIES)
    : [];
  const guideIds = requestedGuideIds(body);
  if (guideIds === null) {
    return {
      error: `At most ${MAX_ORG_GLOSSARIES_PER_REQUEST} organization glossaries per run`,
    };
  }
  if (guideIds.length === 0) return { entries: personal };
  // Guide access rules with group scope read this cache synchronously.
  await resolveUserGroupIds(req, session);
  const resolved = await resolveOrgGlossaries(
    session.user?.mail ?? undefined,
    guideIds,
  );
  if ('error' in resolved) return { error: resolved.error };
  return {
    entries: mergeGlossaryEntries(resolved.entries, personal).slice(
      0,
      MAX_MERGED_ENTRIES,
    ),
  };
}
