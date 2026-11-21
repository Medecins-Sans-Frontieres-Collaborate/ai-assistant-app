import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { BrandFileError } from '@/lib/services/brand/brandBooks';
import { storeBrandGuideUpload } from '@/lib/services/brand/brandGuideUpload';

import {
  badRequestResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export const maxDuration = 300;

/**
 * POST /api/agent-access/brand-books/guide: a brand guide PDF, sent as the
 * request's own bytes by an admin (brandGuideUpload.ts). It is kept among
 * the admin's uploads; drafting reads it from there and a save copies it
 * into the book as its source.
 *
 * Returns `{ file: "/api/file/<sha256>.pdf", bytes }`; 400 for a file that
 * is empty, too large or not a PDF.
 */
export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    return successResponse(await storeBrandGuideUpload(session, request));
  } catch (error) {
    if (error instanceof BrandFileError) {
      return badRequestResponse(error.message);
    }
    return handleApiError(error, 'Failed to upload the brand guide');
  }
}
