import { NextRequest, NextResponse } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  writeSkill,
  writeSkillHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';
import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import {
  SKILL_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import { authorizeSkillDocuments } from '@/lib/services/skills/skillDocumentAuth';
import {
  discardSkillFiles,
  readSkillOriginal,
  storeSkillFiles,
} from '@/lib/services/skills/skillDocumentStore';
import { validateSkillFiles } from '@/lib/services/skills/skillFiles';
import { readSkillMultipart } from '@/lib/services/skills/skillMultipart';
import { deleteSkillChunks } from '@/lib/services/skills/skillSearch';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

type RouteContext = { params: Promise<{ id: string }> };

/** Admin download also works for inactive skills under the same per-key gate. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const authorized = await authorizeSkillDocuments(id);
    if (authorized.response) return authorized.response;
    const document = authorized.skill.documents.find(
      (doc) => doc.fileId === request.nextUrl.searchParams.get('fileId'),
    );
    if (!document) return notFoundResponse('Resource');
    const bytes = await readSkillOriginal(
      authorized.storage,
      id,
      document.fileId,
      request.signal,
    );
    if (!bytes) return notFoundResponse('Resource');
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return handleApiError(error, 'Could not download skill resource');
  }
}

/** Adds validated originals atomically to the skill manifest; indexing is resumable. */
export async function POST(request: NextRequest, context: RouteContext) {
  return mutate(request, context, false);
}
/** Removes the manifest entry before cleaning up blobs/index chunks. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  return mutate(request, context, true);
}

async function mutate(
  request: NextRequest,
  context: RouteContext,
  removing: boolean,
) {
  try {
    const { id } = await context.params;
    const authorized = await authorizeSkillDocuments(id);
    if (authorized.response) return authorized.response;
    const { storage, skill, userMail } = authorized;
    const etag = request.headers.get('if-match');
    if (!etag || !STRONG_ETAG_REGEX.test(etag))
      return badRequestResponse('If-Match must be a quoted strong ETag');
    if (etag !== authorized.etag) throw new AgentAccessConflictError();
    let documents = skill.documents;
    let added: typeof documents = [];
    const fileId = request.nextUrl.searchParams.get('fileId');
    const removed = removing
      ? documents.find((doc) => doc.fileId === fileId)
      : undefined;
    if (removing) {
      if (!removed) return notFoundResponse('Skill resource');
      documents = documents.filter((doc) => doc.fileId !== fileId);
    } else {
      const form = await readSkillMultipart(request);
      const files = form
        .getAll('files')
        .filter((file): file is File => file instanceof File);
      if (!files.length)
        return badRequestResponse('At least one file is required');
      validateSkillFiles([
        ...documents.map((doc) => ({
          name: doc.resourcePath ?? doc.filename,
          size: doc.sizeBytes,
        })),
        ...files,
      ]);
      added = await storeSkillFiles(storage, id, files, userMail);
      documents = [...documents, ...added];
    }
    const updated = {
      ...skill,
      documents,
      updatedAt: new Date().toISOString(),
      updatedBy: userMail,
    };
    let nextEtag: string;
    try {
      nextEtag = await writeSkill(storage, updated, etag);
    } catch (error) {
      await discardSkillFiles(storage, id, added);
      throw error;
    }
    AgentAccessService.getInstance().invalidate();
    try {
      await writeSkillHistoryEntry(storage, {
        version: 1,
        canonicalKey: canonicalAgentKey(SKILL_SOURCE, id),
        action: 'upsert',
        skill: updated,
        updatedBy: userMail,
        updatedAt: updated.updatedAt,
      });
    } catch (error) {
      console.error('[skills] Document audit write failed', error);
    }
    if (removed) {
      await discardSkillFiles(storage, id, [removed]);
      try {
        await deleteSkillChunks(removed.fileId, removed.chunkCount ?? 300);
      } catch (error) {
        console.error('[skills] Search cleanup failed', error);
      }
    }
    return successResponse({ skill: updated, etag: nextEtag });
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return errorResponse(
        'Skill changed; reload and retry',
        409,
        undefined,
        'AGENT_ACCESS_CONFLICT',
      );
    return handleApiError(error, 'Could not update skill documents');
  }
}
