/**
 * People autocomplete for user-initiated recipient fields (the OneDrive
 * share dialog).
 *
 * GET /api/m365/people/search?q=ann
 *
 * Two tolerant Graph lookups with the CALLER'S delegated token:
 *   1. /me/people $search — relevance-ranked people the user actually
 *      interacts with (People.Read); almost always the right suggestions.
 *   2. /users startswith — directory supplement (User.Read.All) so
 *      colleagues the user has never mailed are still findable. Skipped
 *      when the ranked results already fill the list.
 * Either call failing (missing consent, throttle) degrades to whatever the
 * other returned — autocomplete is a convenience, never an error surface.
 *
 * Returns display data only (name + email) — no ids, no org attributes.
 */
import { NextRequest } from 'next/server';

import { graphJson } from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const MAX_RESULTS = 8;
const MAX_QUERY_CHARS = 60;

export interface PersonSuggestion {
  displayName: string;
  email: string;
}

interface GraphPerson {
  displayName?: string;
  scoredEmailAddresses?: { address?: string }[];
}

interface GraphUser {
  displayName?: string;
  mail?: string;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return unauthorizedResponse();

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 2) return badRequestResponse('Query too short');
  if (q.length > MAX_QUERY_CHARS) return badRequestResponse('Query too long');

  const suggestions: PersonSuggestion[] = [];
  const seen = new Set<string>();
  const add = (displayName: string | undefined, email: string | undefined) => {
    const address = email?.trim().toLowerCase();
    if (!address || seen.has(address)) return;
    seen.add(address);
    suggestions.push({
      displayName: displayName?.trim() || address,
      email: address,
    });
  };

  // Ranked people first. $search takes a quoted string — strip quote
  // characters from the query rather than escaping (they're never
  // meaningful in a name/email prefix).
  const searchTerm = q.replace(/["']/g, '');
  if (searchTerm.length >= 2) {
    try {
      const people = await graphJson<{ value?: GraphPerson[] }>(
        req,
        ['People.Read'],
        `/me/people?$search="${encodeURIComponent(searchTerm)}"` +
          `&$select=displayName,scoredEmailAddresses&$top=${MAX_RESULTS}`,
      );
      for (const person of people.value ?? []) {
        add(person.displayName, person.scoredEmailAddresses?.[0]?.address);
      }
    } catch {
      // Tolerant: fall through to the directory lookup.
    }
  }

  // Directory supplement for never-contacted colleagues.
  if (suggestions.length < MAX_RESULTS) {
    const literal = searchTerm.replace(/'/g, '');
    try {
      const users = await graphJson<{ value?: GraphUser[] }>(
        req,
        ['User.Read.All'],
        `/users?$filter=${encodeURIComponent(
          `startswith(displayName,'${literal}') or startswith(mail,'${literal}')`,
        )}&$select=displayName,mail&$top=${MAX_RESULTS}`,
      );
      for (const user of users.value ?? []) {
        add(user.displayName, user.mail);
      }
    } catch {
      // Tolerant: serve whatever the ranked lookup produced.
    }
  }

  return successResponse({ people: suggestions.slice(0, MAX_RESULTS) });
}
