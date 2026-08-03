/**
 * M365 Connection Status
 *
 * Reports, per feature area, whether the tenant grant actually works for the
 * signed-in user — by minting a delegated token per scope set (no Graph data
 * calls). Drives the Settings → Connections panel and lets feature UI hide
 * actions whose consent hasn't landed yet.
 *
 * GET /api/m365/status
 */
import { NextRequest } from 'next/server';

import {
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import type { M365FeatureKey, M365FeatureStatus } from '@/types/m365';

import { auth, getGraphAccessToken } from '@/auth';

const FEATURE_SCOPES: Record<M365FeatureKey, string[]> = {
  files: ['Files.ReadWrite.All'],
  sharepoint: ['Sites.Read.All'],
  sharepointWrite: ['Sites.ReadWrite.All'],
  mail: ['Mail.Read'],
  mailDrafts: ['Mail.ReadWrite'],
  calendar: ['Calendars.ReadWrite'],
  people: ['People.Read', 'Contacts.Read'],
  orgDirectory: ['User.Read.All'],
  tasks: ['Tasks.ReadWrite'],
  meetings: [
    'OnlineMeetings.Read',
    'OnlineMeetingTranscript.Read.All',
    'OnlineMeetingRecording.Read.All',
  ],
  teamsChats: ['Chat.Read'],
  teamsChannels: [
    'ChannelMessage.Read.All',
    'Team.ReadBasic.All',
    'Channel.ReadBasic.All',
  ],
  groups: ['Group.Read.All'],
};

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const entries = await Promise.all(
    Object.entries(FEATURE_SCOPES).map(
      async ([feature, scopes]): Promise<[string, M365FeatureStatus]> => {
        const token = await getGraphAccessToken(req, scopes);
        if (token.accessToken) return [feature, 'granted'];
        const consentMissing = token.error?.includes('AADSTS65001') ?? false;
        return [feature, consentMissing ? 'consent_missing' : 'error'];
      },
    ),
  );

  return successResponse({
    features: Object.fromEntries(entries) as Record<
      M365FeatureKey,
      M365FeatureStatus
    >,
  });
}
