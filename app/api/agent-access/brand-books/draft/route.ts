import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { draftBrandBook } from '@/lib/services/brand/brandBookDraft';
import {
  BrandFileError,
  readBrandUpload,
} from '@/lib/services/brand/brandBooks';
import { DocumentRefusedError } from '@/lib/services/documents/model/inspect';
import { renderErrorResponse } from '@/lib/services/documents/render/renderErrorResponse';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export const maxDuration = 300;

/**
 * POST /api/agent-access/brand-books/draft: a draft brand book from a
 * brand guide PDF the admin uploaded (brandBookDraft.ts). Nothing is
 * stored: the admin checks the draft in the editor and saves it there,
 * which copies the guide into the book as its source.
 *
 * Body: `{ file: "/api/file/<sha256>.pdf", name: "Guide.pdf" }`.
 */
export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  let body: { file?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  if (typeof body.file !== 'string') {
    return badRequestResponse('file is required');
  }
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 200)
      : 'Brand guide.pdf';

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    const guide = await readBrandUpload(session, body.file, 'source');
    const { denied, usage } = await beginWorkflowRun(
      session,
      'brand-book-draft',
    );
    if (denied) return denied;
    const draft = await draftBrandBook({
      guide: guide.data,
      source: { file: body.file, name },
      usage,
      model: resolveWorkflowModelId(),
      signal: request.signal,
    });
    return successResponse({ ...draft, usage: usage.fields().usage });
  } catch (error) {
    if (error instanceof BrandFileError) {
      return badRequestResponse(error.message);
    }
    if (error instanceof DocumentRefusedError) {
      return errorResponse(
        error.message,
        422,
        undefined,
        `DOCUMENT_${error.code}`,
      );
    }
    return (
      renderErrorResponse(error) ??
      handleApiError(error, 'Failed to draft a brand book')
    );
  }
}
