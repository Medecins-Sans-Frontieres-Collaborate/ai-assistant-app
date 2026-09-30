import { NextRequest } from 'next/server';

import { loadChannelSetsFor } from '@/lib/services/workflows/channelDrafter/channelSetService';
import { isWorkflowEnabled } from '@/lib/services/workflows/policy/guard';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { pickChannelSet } from '@/lib/utils/shared/drafter/channels/channelSets';

import { auth } from '@/auth';

/**
 * GET /api/channel-sets — the channel rule sets THIS user may draft with,
 * each with the channels it offers already merged with the platforms, and
 * the set they land in with nothing chosen (`suggestedSetId`). Empty when
 * the workflow is switched off.
 *
 * The client falls back to the built-in default set if this request fails,
 * so the list here is about correctness, not availability.
 *
 * `publishTarget` (a team's Hootsuite profile id) is admin data a drafter
 * never needs: whether a channel can be sent to is the publish route's
 * answer, so the field is removed here.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('channel-drafter'))) {
    return successResponse({ sets: [], suggestedSetId: null });
  }
  try {
    const sets = (await loadChannelSetsFor(request, session, 'discovery')).map(
      (set) => ({
        ...set,
        channels: set.channels.map(
          ({ publishTarget: _publishTarget, ...profile }) => profile,
        ),
      }),
    );
    return successResponse({
      sets,
      suggestedSetId: pickChannelSet(sets)?.id ?? null,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list channel sets');
  }
}
