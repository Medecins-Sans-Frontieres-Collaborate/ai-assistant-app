import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  createAgentAccessBlobStorage,
  deleteMapDataset,
  readMapDataset,
  writeMapDataset,
  writeMapDatasetHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import {
  STRONG_ETAG_REGEX,
  auditAdminWrite,
  canEditKey,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
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
import { normalizeEventRange } from '@/lib/utils/shared/date/eventRange';
import { isValidCoordinate } from '@/lib/utils/shared/geo/geojson';
import {
  MAX_DATASET_CONNECTIONS,
  MAX_DATASET_DESCRIPTION_CHARS,
  MAX_DATASET_FEATURES,
  MAX_DATASET_NAME_CHARS,
} from '@/lib/utils/shared/geo/mapLimits';

import { auth } from '@/auth';
import { z } from 'zod';

/**
 * GET/PUT/DELETE /api/agent-access/map-datasets/[id] — single-dataset admin
 * operations. Split from the collection route because this GET ships the
 * full (~1MB) payload and its ETag is the CAS anchor for PUT/DELETE.
 */

export const MAP_DATASET_ID_PATTERN = /^mapds-[a-f0-9]{12}$/;

const featureSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(300),
    description: z.string().max(2000).default(''),
    lat: z.number(),
    lon: z.number(),
    confidence: z.enum(['high', 'medium', 'low']),
    confidenceReason: z.string().max(1000).default(''),
    category: z.string().max(100).default(''),
    event: z
      .object({
        start: z.string().min(1),
        end: z.string().min(1).nullable(),
        precision: z.enum(['minute', 'hour', 'day', 'month', 'year']),
        ongoing: z.boolean().optional(),
      })
      .optional(),
    prominence: z.enum(['primary', 'secondary', 'mention']).optional(),
    granularity: z
      .enum(['site', 'city', 'district', 'region', 'country'])
      .optional(),
    countryCode: z.string().length(2).optional(),
    parentName: z.string().max(300).optional(),
    approxRadiusKm: z.number().nonnegative().optional(),
    sourceId: z.string().max(100).optional(),
  })
  .strict();

const connectionSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    fromId: z.string().min(1),
    toId: z.string().min(1),
    kind: z.string().max(100).default(''),
    description: z.string().max(500).default(''),
    sourceId: z.string().max(100).optional(),
  })
  .strict();

const sourceRecordSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(300),
    addedAt: z.string(),
    featureCount: z.number().int().nonnegative(),
    kind: z.enum(['text', 'file', 'search', 'url']).optional(),
    query: z.string().max(500).optional(),
    url: z.string().max(2000).optional(),
  })
  .strict();

const putBodySchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_DATASET_NAME_CHARS),
    description: z
      .string()
      .trim()
      .max(MAX_DATASET_DESCRIPTION_CHARS)
      .default(''),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    features: z.array(featureSchema).max(MAX_DATASET_FEATURES),
    connections: z
      .array(connectionSchema)
      .max(MAX_DATASET_CONNECTIONS)
      .default([]),
    sources: z.array(sourceRecordSchema).max(200).default([]),
  })
  .strict();

/**
 * Cross-field validation: features referenced by id must actually exist and
 * ids must be unique — a dataset with dangling connections or duplicate ids
 * would corrupt every workspace that loads it.
 */
function validateDatasetShape(
  body: z.infer<typeof putBodySchema>,
): string | null {
  const ids = new Set<string>();
  for (const feature of body.features) {
    if (ids.has(feature.id)) {
      return `Duplicate feature id: ${feature.id}`;
    }
    ids.add(feature.id);
    if (!isValidCoordinate(feature.lat, feature.lon)) {
      return `Invalid coordinates for feature "${feature.name}"`;
    }
  }
  for (const connection of body.connections) {
    if (!ids.has(connection.fromId) || !ids.has(connection.toId)) {
      return 'Connection references a feature id that does not exist';
    }
  }
  return null;
}

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

function conflictResponse(service: AgentAccessService) {
  service.invalidate();
  return errorResponse(
    'Dataset was modified by another admin; reload and retry',
    409,
    undefined,
    'AGENT_ACCESS_CONFLICT',
  );
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Shared gate: flag → auth → mail → id shape → admin + key authorization. */
async function authorizeAdmin(
  id: string,
): Promise<
  | { ok: true; userMail: string; canonicalKey: string }
  | { ok: false; response: Response }
> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) {
    return { ok: false, response: notFoundResponse('Resource') };
  }
  const session = await auth();
  if (!session?.user) return { ok: false, response: unauthorizedResponse() };
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return { ok: false, response: forbiddenResponse() };
  if (!MAP_DATASET_ID_PATTERN.test(id)) {
    return {
      ok: false,
      response: badRequestResponse('id is not a valid dataset id'),
    };
  }
  const canonicalKey = canonicalAgentKey(MAP_DATASET_SOURCE, id);
  await service.ensureFresh();
  const status = resolveAdminStatus(session.user, service.getSnapshot().config);
  if (!status.isGlobalAdmin && !status.isLocalAdmin) {
    return { ok: false, response: forbiddenResponse() };
  }
  if (!canEditKey(status, canonicalKey)) {
    return {
      ok: false,
      response: forbiddenResponse('Not authorized for this dataset key'),
    };
  }
  return { ok: true, userMail, canonicalKey };
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    const authz = await authorizeAdmin(id);
    if (!authz.ok) return authz.response;

    // Direct read — the echoed etag feeds the If-Match CAS on PUT/DELETE.
    const existing = await readMapDataset(createAgentAccessBlobStorage(), id);
    if (existing === null) return notFoundResponse('Dataset');

    return successResponse({
      dataset: existing.dataset,
      etag: existing.etag,
      canonicalKey: authz.canonicalKey,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to load map dataset');
  }
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const service = AgentAccessService.getInstance();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  try {
    const authz = await authorizeAdmin(id);
    if (!authz.ok) return authz.response;

    const parsed = putBodySchema.safeParse(body);
    if (!parsed.success) {
      return badRequestResponse(
        'Invalid dataset body',
        parsed.error.issues.map((i) => i.path.join('.')).join(', '),
      );
    }
    const shapeError = validateDatasetShape(parsed.data);
    if (shapeError) return badRequestResponse(shapeError);

    const ifMatchEtag = request.headers.get('if-match');
    if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
      return badRequestResponse('If-Match must be a quoted strong ETag');
    }

    const existing = await readMapDataset(createAgentAccessBlobStorage(), id);
    if (existing === null) return notFoundResponse('Dataset');

    const now = new Date().toISOString();
    // Explicit construction — id/createdBy/createdAt survive from the
    // stored record, everything else is the submitted draft. Events are
    // normalized exactly like the extraction route does.
    const dataset: MapDataset = {
      version: 1,
      id: existing.dataset.id,
      name: parsed.data.name,
      description: parsed.data.description,
      tags: parsed.data.tags,
      features: parsed.data.features.map((feature) => ({
        ...feature,
        event: feature.event
          ? (normalizeEventRange(feature.event) ?? undefined)
          : undefined,
        countryCode: feature.countryCode?.toUpperCase(),
      })),
      connections: parsed.data.connections,
      sources: parsed.data.sources,
      createdBy: existing.dataset.createdBy,
      createdAt: existing.dataset.createdAt,
      updatedBy: authz.userMail,
      updatedAt: now,
    };

    const etag = await writeMapDataset(
      createAgentAccessBlobStorage(),
      dataset,
      ifMatchEtag,
    );
    service.invalidate();
    auditAdminWrite('map-dataset-upsert', authz.canonicalKey, authz.userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey: authz.canonicalKey,
      action: 'upsert',
      meta: mapDatasetMeta(dataset),
      updatedBy: authz.userMail,
      updatedAt: now,
    });

    return successResponse({
      dataset,
      etag,
      canonicalKey: authz.canonicalKey,
    });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to update map dataset');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const service = AgentAccessService.getInstance();

  try {
    const authz = await authorizeAdmin(id);
    if (!authz.ok) return authz.response;

    const ifMatchEtag = request.headers.get('if-match');
    if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
      return badRequestResponse('If-Match must be a quoted strong ETag');
    }

    // Data blob first (CAS), meta best-effort inside — a repeated DELETE
    // also cleans an orphaned meta. Dangling delegation keys in config are
    // documented-acceptable, matching the other entities.
    const deleted = await deleteMapDataset(
      createAgentAccessBlobStorage(),
      id,
      ifMatchEtag,
    );
    if (!deleted) return notFoundResponse('Dataset');
    service.invalidate();
    auditAdminWrite('map-dataset-delete', authz.canonicalKey, authz.userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey: authz.canonicalKey,
      action: 'delete',
      meta: null,
      updatedBy: authz.userMail,
      updatedAt: new Date().toISOString(),
    });

    return successResponse({ canonicalKey: authz.canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to delete map dataset');
  }
}
