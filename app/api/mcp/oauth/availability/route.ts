import { getCatalogOauthAppAvailability } from '@/lib/services/mcp/mcpOauthDiscovery';

import {
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/mcp/oauth/availability — per-catalog-key booleans for "does this
 * deployment have an OAuth app for this connector".
 *
 * Lets the Connectors settings UI hide "Connect with {name}" when the click
 * could only fail (see getCatalogOauthAppAvailability). Response carries
 * booleans only: no client ids, no secrets, no endpoints. Auth-gated and
 * uncached because the answer is deployment config, not user data — but it
 * still shouldn't be an anonymous probe of our integration surface.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  return successResponse({
    availability: await getCatalogOauthAppAvailability(),
  });
}
