import { NextRequest, NextResponse } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { canEditKey } from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  BRAND_BOOK_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import { readStoredBrandFile } from '@/lib/services/brand/brandBooks';

import {
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/agent-access/brand-books/files?id=&name=: a stored file of a
 * brand book, for an admin who may edit it (its logos shown in the
 * editor even when the book's access rule does not include them). Served
 * like the person's file route: own type, never sniffed, sandboxed.
 */
export async function GET(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const id = request.nextUrl.searchParams.get('id') ?? '';
  const name = request.nextUrl.searchParams.get('name') ?? '';
  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalAgentKey(BRAND_BOOK_SOURCE, id))) {
      return notFoundResponse('File');
    }
    const file = await readStoredBrandFile(id, name);
    if (!file) return notFoundResponse('File');
    return new NextResponse(new Uint8Array(file.data), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Length': String(file.data.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (error) {
    return handleApiError(error, 'Failed to read brand book file');
  }
}
