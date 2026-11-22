import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { currentPolicy } from '@/lib/services/limits/enforcement';
import { loadUsageInsights } from '@/lib/services/limits/usageInsights';

import {
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/limits/insights — usage evidence for the limits admin: how close
 * people came to their caps over the last week, and how often a cap stopped
 * (or, in observe mode, would have stopped) them. Global admins only; the
 * answer holds counts and anonymous per-person peaks, never who anyone is.
 *
 * Missing day summaries are built in the background: the answer then says
 * `status: 'building'` and the client asks again.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();

  try {
    const policy = await currentPolicy();
    return successResponse(await loadUsageInsights(policy?.timezone ?? 'UTC'));
  } catch (error) {
    return handleApiError(error, 'Failed to load usage insights');
  }
}
