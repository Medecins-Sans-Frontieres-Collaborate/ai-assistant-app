/**
 * People tools (fourth pass B2): person_resolve, person_lookup. graphApi is
 * lazy-imported inside each function so this module graph stays free of
 * next-auth.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  M365ToolInputError,
  catalogScopes,
  clampNumber,
  escapeODataLiteral,
  isValidEmail,
  optionalString,
  requireString,
  truncateText,
} from '@/lib/services/m365/tools/shared';

interface GraphPerson {
  displayName?: string;
  scoredEmailAddresses?: { address?: string }[];
  jobTitle?: string;
  department?: string;
}

interface GraphContact {
  displayName?: string;
  emailAddresses?: { address?: string }[];
}

interface Candidate {
  name: string;
  email: string;
  title?: string;
  department?: string;
}

function renderCandidate(candidate: Candidate, rank: number): string {
  const detail = [candidate.title, candidate.department]
    .filter(Boolean)
    .join(', ');
  return `${rank}. ${candidate.name}${detail ? ` — ${detail}` : ''} — ${candidate.email}`;
}

export async function personResolve(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  // Double quotes delimit the $search phrase; strip them from user text.
  const query = requireString(args, 'query').replace(/"/g, '').trim();
  if (!query) {
    throw new M365ToolInputError('query must contain searchable text');
  }
  const maxResults = clampNumber(args, 'maxResults', 5, 10);

  const scopes = catalogScopes('person_resolve');
  const { graphJson } = await import('@/lib/services/m365/graphApi');

  const people = await graphJson<{ value?: GraphPerson[] }>(
    req,
    scopes,
    `/me/people?$search=${encodeURIComponent(`"${query}"`)}` +
      `&$select=displayName,scoredEmailAddresses,jobTitle,department` +
      `&$top=${maxResults}`,
  );

  // Personal contacts folded in, individually error-tolerant — /me/people
  // is the primary, relevance-ordered source.
  let contacts: GraphContact[] = [];
  try {
    const contactData = await graphJson<{ value?: GraphContact[] }>(
      req,
      scopes,
      `/me/contacts?$filter=${encodeURIComponent(
        `startswith(displayName,'${escapeODataLiteral(query)}')`,
      )}&$select=displayName,emailAddresses&$top=5`,
    );
    contacts = contactData.value ?? [];
  } catch {
    contacts = [];
  }

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const person of people.value ?? []) {
    const email = person.scoredEmailAddresses?.[0]?.address;
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    candidates.push({
      name: person.displayName ?? email,
      email,
      ...(person.jobTitle && { title: person.jobTitle }),
      ...(person.department && { department: person.department }),
    });
  }
  for (const contact of contacts) {
    const email = contact.emailAddresses?.[0]?.address;
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    candidates.push({
      name: contact.displayName ?? email,
      email,
      title: 'personal contact',
    });
  }

  if (candidates.length === 0) {
    return `No people matched "${truncateText(query, 60)}".`;
  }
  const capped = candidates.slice(0, maxResults);
  const header =
    candidates.length > capped.length
      ? `People matching "${query}" (showing ${capped.length} of ${candidates.length}):`
      : `People matching "${query}" (${capped.length}):`;
  return [
    header,
    ...capped.map((candidate, i) => renderCandidate(candidate, i + 1)),
  ].join('\n');
}

interface GraphUser {
  id?: string;
  displayName?: string;
  jobTitle?: string;
  department?: string;
  mail?: string;
  officeLocation?: string;
}

function userLine(user: GraphUser): string {
  return [user.displayName ?? '(unknown)', user.jobTitle, user.mail]
    .filter(Boolean)
    .join(' — ');
}

export async function personLookup(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const target = requireString(args, 'userIdOrEmail');
  const include = optionalString(args, 'include') ?? 'all';
  if (!['profile', 'manager', 'directReports', 'all'].includes(include)) {
    throw new M365ToolInputError(
      'include must be one of profile, manager, directReports, all',
    );
  }

  const scopes = catalogScopes('person_lookup');
  const { graphJson, isValidGraphId } =
    await import('@/lib/services/m365/graphApi');
  if (!isValidEmail(target) && !isValidGraphId(target)) {
    throw new M365ToolInputError(
      'userIdOrEmail must be an email address or a directory object id',
    );
  }

  const key = encodeURIComponent(target);
  const user = await graphJson<GraphUser>(
    req,
    scopes,
    `/users/${key}?$select=id,displayName,jobTitle,department,mail,officeLocation`,
  );

  const lines = [userLine(user)];
  if (user.department) lines.push(`Department: ${user.department}`);
  if (user.officeLocation) lines.push(`Office: ${user.officeLocation}`);

  // Sub-calls are individually error-tolerant: a 404 manager is "none
  // listed", not a tool failure.
  if (include === 'manager' || include === 'all') {
    try {
      const manager = await graphJson<GraphUser>(
        req,
        scopes,
        `/users/${key}/manager?$select=displayName,mail,jobTitle`,
      );
      lines.push(`Manager: ${userLine(manager)}`);
    } catch {
      lines.push('Manager: none listed');
    }
  }
  if (include === 'directReports' || include === 'all') {
    try {
      const reports = await graphJson<{ value?: GraphUser[] }>(
        req,
        scopes,
        `/users/${key}/directReports?$select=displayName,mail,jobTitle&$top=20`,
      );
      const entries = reports.value ?? [];
      if (entries.length === 0) {
        lines.push('Direct reports: none listed');
      } else {
        lines.push(`Direct reports (${entries.length}):`);
        for (const report of entries) {
          lines.push(`- ${userLine(report)}`);
        }
      }
    } catch {
      lines.push('Direct reports: unavailable');
    }
  }
  return lines.join('\n');
}
