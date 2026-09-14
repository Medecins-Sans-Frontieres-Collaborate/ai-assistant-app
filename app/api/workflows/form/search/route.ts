import { NextRequest } from 'next/server';

import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import {
  formatCitationList,
  runGroundedSearch,
} from '@/lib/services/workflows/shared/groundedSearch';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { FORM_LIMITS, SOURCE_TEXT_STATE_CAP } from '@/types/formFill';

import { auth } from '@/auth';

// One grounded search (30-90s on the Foundry agent path).
export const maxDuration = 180;

interface SearchRequest {
  query: string;
  conversationId?: string;
}

/**
 * POST /api/workflows/form/search — runs the app's grounded web search for
 * a user-written query and returns the answer text plus citations as one
 * `search` source. Only the query leaves the app (docs/FORM_FILL_WORKFLOW.md).
 * The search runs on the shared seam, so the engine is swappable by
 * `WEB_SEARCH_PROVIDER` without touching this route.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('form-fill'))) {
    return workflowDisabledResponse('form-fill');
  }

  let body: SearchRequest;
  try {
    body = (await req.json()) as SearchRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return badRequestResponse('A search query is required');
  if (query.length > FORM_LIMITS.MAX_SEARCH_QUERY_CHARS) {
    return badRequestResponse('Search query is too long');
  }

  try {
    const result = await runGroundedSearch(query, session.user);
    if (result === null) {
      return badRequestResponse(
        'Web search is not available in this environment',
        'SEARCH_UNAVAILABLE',
      );
    }
    const text = `${result.text}${formatCitationList(result.citations)}`.slice(
      0,
      SOURCE_TEXT_STATE_CAP,
    );
    return successResponse({
      query,
      text,
      citations: result.citations.map((c) => ({ title: c.title, url: c.url })),
      truncated: text.length < result.text.length,
    });
  } catch (error) {
    console.error(`[workflows/form/search] Failed: ${sanitizeForLog(error)}`);
    return handleApiError(error, 'Search failed');
  }
}
