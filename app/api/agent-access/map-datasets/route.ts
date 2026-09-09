import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredMapDatasetMeta,
  createAgentAccessBlobStorage,
  deleteMapDataset,
  listAllMapDatasetMetas,
  readConfig,
  writeMapDataset,
  writeMapDatasetHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  ALL_AGENT_KEYS,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import {
  auditAdminWrite,
  canEditKey,
  delegateToCreator,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  AgentAccessConfig,
  MAP_DATASET_SOURCE,
  MapDataset,
  MapDatasetHistoryEntry,
  canonicalAgentKey,
  mapDatasetMeta,
} from '@/lib/services/agentAccess/types';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import {
  MAX_DATASET_DESCRIPTION_CHARS,
  MAX_DATASET_NAME_CHARS,
} from '@/lib/utils/shared/geo/mapLimits';

import { auth } from '@/auth';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * GET/POST /api/agent-access/map-datasets — admin listing + creation for
 * admin-curated map datasets. 404 while the feature is disabled. Any admin
 * (global or local) may create; per-dataset authorization is keyed
 * `map-dataset::<id>` exactly like the other entities.
 *
 * The listing serves META records only — dataset payloads (~1MB) live in a
 * separate data blob read by the [id] routes. No ETags here: the CAS anchor
 * is the data blob, echoed by GET /api/agent-access/map-datasets/[id].
 */

const createBodySchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_DATASET_NAME_CHARS),
    description: z
      .string()
      .trim()
      .max(MAX_DATASET_DESCRIPTION_CHARS)
      .default(''),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  })
  .strict();

/** Best-effort history append (mutation already landed; never fail it). */
async function appendHistoryBestEffort(
  entry: MapDatasetHistoryEntry,
): Promise<void> {
  try {
    await writeMapDatasetHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

/**
 * Best-effort removal of a just-created dataset whose delegation could not
 * be recorded. Returns whether it is actually gone (see the guides route for
 * the full rationale — never claim a rollback that did not happen).
 */
async function rollbackCreate(
  id: string,
  etag: string,
  canonicalKey: string,
  userMail: string,
): Promise<boolean> {
  try {
    await deleteMapDataset(createAgentAccessBlobStorage(), id, etag);
    auditAdminWrite('map-dataset-delete', canonicalKey, userMail);
    return true;
  } catch (error) {
    console.error(
      `[agent-access-admin] ROLLBACK DELETE FAILED — map dataset id=${sanitizeForLog(id)} key=${sanitizeForLog(canonicalKey)} still exists WITHOUT delegation and needs global-admin cleanup: ${sanitizeForLog(error)}`,
    );
    return false;
  }
}

export async function GET() {
  // Feature flag BEFORE auth: a disabled deployment must answer 404 to
  // everyone, exactly like a route that does not exist.
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    let stored: StoredMapDatasetMeta[] = [];
    let config: AgentAccessConfig | null = null;
    let datasetsUnavailable = false;
    let fetchedAt: number | null = null;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listed, configResult] = await Promise.all([
        listAllMapDatasetMetas(storage),
        readConfig(storage),
      ]);
      stored = listed;
      config = configResult?.config ?? null;
      fetchedAt = Date.now();
    } catch (error) {
      // Same outage contract as the other admin listings: empty list flagged
      // unavailable, not a 500; authorization falls back to the ≤60s-stale
      // snapshot config so local admins get the same degraded 200.
      console.error(
        `[agent-access-admin] direct map-dataset meta read failed: ${sanitizeForLog(error)}`,
      );
      datasetsUnavailable = true;
      config = service.getSnapshot().config;
    }

    const status = resolveAdminStatus(session.user, config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    const visible =
      status.editableAgentKeys === ALL_AGENT_KEYS
        ? stored
        : stored.filter((entry) => canEditKey(status, entry.canonicalKey));

    return successResponse({
      datasets: visible.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        meta: entry.meta,
      })),
      datasetsUnavailable,
      fetchedAt,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list map datasets');
  }
}

export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid dataset body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    // Server-generated immutable id; the canonical key and blob paths hang
    // off it. Datasets start EMPTY — curation happens in the editor.
    const id = `mapds-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const canonicalKey = canonicalAgentKey(MAP_DATASET_SOURCE, id);
    const now = new Date().toISOString();
    const dataset: MapDataset = {
      version: 1,
      id,
      name: parsed.data.name,
      description: parsed.data.description,
      tags: parsed.data.tags,
      features: [],
      connections: [],
      sources: [],
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writeMapDataset(
      createAgentAccessBlobStorage(),
      dataset,
      null,
    );
    service.invalidate();
    auditAdminWrite('map-dataset-upsert', canonicalKey, userMail);

    if (!status.isGlobalAdmin) {
      const delegated = await delegateToCreator(userMail, canonicalKey);
      if (!delegated) {
        const rolledBack = await rollbackCreate(
          id,
          etag,
          canonicalKey,
          userMail,
        );
        service.invalidate();
        if (!rolledBack) {
          await appendHistoryBestEffort({
            version: 1,
            canonicalKey,
            action: 'upsert',
            meta: mapDatasetMeta(dataset),
            updatedBy: userMail,
            updatedAt: now,
          });
          return errorResponse(
            `Could not record delegation AND rollback failed: map dataset ${id} still exists without delegation and needs global-admin cleanup`,
            503,
          );
        }
        return errorResponse(
          'Could not record delegation; dataset creation rolled back',
          503,
        );
      }
      service.invalidate();
    }

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      meta: mapDatasetMeta(dataset),
      updatedBy: userMail,
      updatedAt: now,
    });

    return successResponse({ dataset, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      service.invalidate();
      return errorResponse(
        'Dataset was modified by another admin; reload and retry',
        409,
        undefined,
        'AGENT_ACCESS_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to create map dataset');
  }
}
