/**
 * Teams (M365 groups) for the file picker's Teams tab (fourth pass A2).
 *
 * GET /api/m365/teams              → the user's joined teams
 * GET /api/m365/teams?groupId=…    → that team's default document library
 *
 * A Teams team IS an M365 group, so "pick from the Logistics team's files"
 * is `/groups/{id}/drive` — the natural pairing with a group access rule
 * granting the same team access to whatever the picked source feeds.
 */
import { NextRequest } from 'next/server';

import {
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const TEAMS_SCOPES = ['Team.ReadBasic.All'];
const DRIVE_SCOPES = ['Files.ReadWrite.All'];

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const groupId = req.nextUrl.searchParams.get('groupId');

  try {
    if (groupId !== null) {
      if (!isValidGraphId(groupId)) {
        return badRequestResponse('Invalid groupId');
      }
      const drive = await graphJson<{ id?: string; name?: string }>(
        req,
        DRIVE_SCOPES,
        `/groups/${encodeURIComponent(groupId)}/drive?$select=id,name`,
      );
      if (!drive.id) {
        return badRequestResponse(
          'This team has no document library',
          'M365_NO_TEAM_DRIVE',
        );
      }
      return successResponse({
        drive: { driveId: drive.id, name: drive.name || 'Documents' },
      });
    }

    const data = await graphJson<{
      value?: { id?: string; displayName?: string }[];
    }>(req, TEAMS_SCOPES, '/me/joinedTeams?$select=id,displayName&$top=100');
    const teams = (data.value ?? [])
      .filter((t): t is { id: string; displayName?: string } => !!t.id)
      .map((t) => ({ groupId: t.id, name: t.displayName || t.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return successResponse({ teams });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
