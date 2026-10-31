import { NextRequest } from 'next/server';

import { createAgentAccessBlobStorage } from '@/lib/services/agentAccess/accessRulesStore';
import { auditAdminWrite } from '@/lib/services/agentAccess/adminRouteHelpers';
import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import { requireSkillSourceAdmin } from '@/lib/services/skills/skillSourceAuth';
import {
  SkillSourcesCorruptError,
  readSkillSources,
  writeSkillSources,
} from '@/lib/services/skills/skillSourceStore';
import {
  detachSkillSource,
  syncSkillSource,
  validateSourceUrl,
} from '@/lib/services/skills/skillSourceSync';
import { SKILL_LIMITS, SkillSource } from '@/lib/services/skills/types';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

import { randomUUID } from 'crypto';
import { z } from 'zod';

export const maxDuration = 120;

const createSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    label: z.string().trim().max(100).optional(),
  })
  .strict();

export async function GET() {
  const gate = await requireSkillSourceAdmin();
  if (gate instanceof Response) return gate;
  try {
    const { document } = await readSkillSources(createAgentAccessBlobStorage());
    return successResponse({ sources: document.sources });
  } catch (error) {
    return handleApiError(error, 'Failed to list skill sources');
  }
}

/** Adds a source and runs its first sync inline so the admin sees the result. */
export async function POST(request: NextRequest) {
  const gate = await requireSkillSourceAdmin();
  if (gate instanceof Response) return gate;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return badRequestResponse('Invalid source');
  let url: URL;
  try {
    url = validateSourceUrl(parsed.data.url);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Invalid source URL',
    );
  }
  const storage = createAgentAccessBlobStorage();
  try {
    const { document, etag, corrupt } = await readSkillSources(storage);
    if (corrupt) throw new SkillSourcesCorruptError();
    if (document.sources.length >= SKILL_LIMITS.maxSkillSources)
      return badRequestResponse(
        `At most ${SKILL_LIMITS.maxSkillSources} skill sources are allowed`,
      );
    if (document.sources.some((source) => source.url === url.toString()))
      return badRequestResponse('This source is already subscribed');
    const source: SkillSource = {
      id: randomUUID(),
      url: url.toString(),
      ...(parsed.data.label ? { label: parsed.data.label } : {}),
      addedBy: gate.userMail,
      addedAt: new Date().toISOString(),
      entries: [],
    };
    await writeSkillSources(
      storage,
      { version: 1, sources: [...document.sources, source] },
      etag,
    );
    auditAdminWrite(
      'skill-source-add',
      `skill-source::${source.id}`,
      gate.userMail,
    );
    const synced = await syncSkillSource(storage, source.id, {
      actor: gate.userMail,
      signal: request.signal,
    });
    return successResponse({ source: synced.source ?? source });
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return errorResponse(
        'Skill sources were modified by another admin; reload and retry',
        409,
        undefined,
        'AGENT_ACCESS_CONFLICT',
      );
    if (error instanceof SkillSourcesCorruptError)
      return errorResponse(
        error.message,
        500,
        undefined,
        'SKILL_SOURCES_CORRUPT',
      );
    return handleApiError(error, 'Failed to add skill source');
  }
}

/** Removes a subscription; its skills stay as ordinary admin-owned skills. */
export async function DELETE(request: NextRequest) {
  const gate = await requireSkillSourceAdmin();
  if (gate instanceof Response) return gate;
  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id || !/^[0-9a-f-]{36}$/.test(id))
    return badRequestResponse('id is not a valid source id');
  const storage = createAgentAccessBlobStorage();
  try {
    const { document, etag, corrupt } = await readSkillSources(storage);
    if (corrupt) throw new SkillSourcesCorruptError();
    const source = document.sources.find((entry) => entry.id === id);
    if (!source) return notFoundResponse('Skill source');
    // Detach FIRST: if it fails the subscription is still listed and the
    // admin can retry; a removed entry with dangling references would be
    // unrecoverable from the UI.
    await detachSkillSource(storage, source, gate.userMail);
    await writeSkillSources(
      storage,
      {
        version: 1,
        sources: document.sources.filter((entry) => entry.id !== id),
      },
      etag,
    );
    auditAdminWrite(
      'skill-source-remove',
      `skill-source::${id}`,
      gate.userMail,
    );
    return successResponse({ removed: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return errorResponse(
        'Skill sources were modified by another admin; reload and retry',
        409,
        undefined,
        'AGENT_ACCESS_CONFLICT',
      );
    if (error instanceof SkillSourcesCorruptError)
      return errorResponse(
        error.message,
        500,
        undefined,
        'SKILL_SOURCES_CORRUPT',
      );
    return handleApiError(error, 'Failed to remove skill source');
  }
}
