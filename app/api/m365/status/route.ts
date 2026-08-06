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

import { CONSENT_ERROR_CODE } from '@/lib/services/m365/graphApi';

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

/** Concurrent token mints per batch — each mint is an AAD refresh-token
 * redemption, and ~14 in one burst per status poll is real ESTS load. */
const MINT_BATCH_SIZE = 4;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const features = Object.entries(FEATURE_SCOPES);
  const entries: [string, M365FeatureStatus][] = [];
  for (let i = 0; i < features.length; i += MINT_BATCH_SIZE) {
    const batch = await Promise.all(
      features
        .slice(i, i + MINT_BATCH_SIZE)
        .map(
          async ([feature, scopes]): Promise<[string, M365FeatureStatus]> => {
            const token = await getGraphAccessToken(req, scopes);
            if (token.accessToken) return [feature, 'granted'];
            const consentMissing =
              token.error?.includes(CONSENT_ERROR_CODE) ?? false;
            return [feature, consentMissing ? 'consent_missing' : 'error'];
          },
        ),
    );
    entries.push(...batch);
    // A missing session means every remaining mint fails identically —
    // one probe answers for all features without ~13 more redemptions.
    if (i === 0 && batch.every(([, status]) => status === 'error')) {
      const remaining = features
        .slice(i + MINT_BATCH_SIZE)
        .map(([feature]): [string, M365FeatureStatus] => [feature, 'error']);
      entries.push(...remaining);
      break;
    }
  }

  return successResponse({
    features: Object.fromEntries(entries) as Record<
      M365FeatureKey,
      M365FeatureStatus
    >,
  });
}
