import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  createAgentAccessBlobStorage,
  deleteCatalogOauthApp,
  listAllCatalogOauthApps,
  readCatalogOauthApp,
  writeCatalogOauthApp,
  writeCatalogOauthAppHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import {
  STRONG_ETAG_REGEX,
  auditAdminWrite,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  isConnectorSecretCryptoConfigured,
  sealConnectorSecret,
} from '@/lib/services/agentAccess/connectorSecretCrypto';
import {
  CATALOG_OAUTH_SOURCE,
  CatalogOauthApp,
  CatalogOauthAppHistoryEntry,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import { getStaticOauthClient } from '@/lib/services/mcp/mcpOauthDiscovery';

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

import { auth } from '@/auth';
import { MCP_CATALOG } from '@/config/mcpCatalog';
import { z } from 'zod';

/**
 * GET/PUT/DELETE /api/agent-access/catalog-oauth — admin management of the
 * deployment's OAuth apps for CURATED catalog connectors (github, asana, …),
 * replacing the MCP_OAUTH_* env vars. 404 while agent access control is
 * disabled.
 *
 * Differences from the connectors CRUD this mirrors:
 *
 * 1. GLOBAL admins only. These credentials apply to every user of the
 *    deployment — the catalog-key records are deployment config, not
 *    delegated per-agent records, so local-admin delegation does not apply.
 * 2. Records are keyed by the compile-time catalog key (no server-generated
 *    ids), and only OAuth-capable catalog entries are accepted.
 * 3. env vars remain the FALLBACK: an admin record overrides them, deleting
 *    it falls back, and GET reports both layers so the UI can say which one
 *    is in effect.
 *
 * The client secret is sealed before it reaches storage and never echoed
 * back (`hasClientSecret` only). Secretless records are allowed — some
 * vendors issue public clients.
 */

/** Catalog keys an OAuth app makes sense for (oauth-capable entries only). */
function oauthCapableCatalogKeys(): Set<string> {
  return new Set(
    Object.values(MCP_CATALOG)
      .filter(
        (entry) => entry.auth.style === 'oauth' || entry.alsoSupportsOauth,
      )
      .map((entry) => entry.key),
  );
}

const putSchema = z
  .object({
    catalogKey: z.string().trim().min(1).max(50),
    clientId: z.string().trim().min(1).max(200),
    /** Omitted → keep stored; '' → clear; non-empty → reseal. */
    clientSecret: z.string().max(500).optional(),
  })
  .strict();

interface AdminGateOk {
  userMail: string;
}

/**
 * The shared 404 → 401 → 403 → global-admin gate. Returns a Response for
 * every failure so handlers can `return` it directly.
 */
async function requireGlobalAdmin(): Promise<AdminGateOk | Response> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) {
    return notFoundResponse('Resource');
  }
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  await service.ensureFresh();
  const status = resolveAdminStatus(session.user, service.getSnapshot().config);
  if (!status.isGlobalAdmin) return forbiddenResponse();
  return { userMail };
}

function appendHistoryBestEffort(entry: CatalogOauthAppHistoryEntry): void {
  void writeCatalogOauthAppHistoryEntry(
    createAgentAccessBlobStorage(),
    entry,
  ).catch((error) => {
    console.error(
      `[agent-access] catalog-oauth history append failed (audit only, write already landed): ${sanitizeForLog(error)}`,
    );
  });
}

/**
 * GET — one row per OAuth-capable catalog entry, whether or not a record is
 * stored, so the admin UI can render the full picture: the admin layer
 * (record + etag for CAS) and the env layer (boolean only — env client ids
 * are deployment secrets' neighbors and stay server-side).
 */
export async function GET() {
  try {
    const gate = await requireGlobalAdmin();
    if (gate instanceof Response) return gate;

    let stored: Awaited<ReturnType<typeof listAllCatalogOauthApps>>;
    let storageUnavailable = false;
    try {
      stored = await listAllCatalogOauthApps(createAgentAccessBlobStorage());
    } catch (error) {
      console.error(
        `[agent-access] catalog-oauth listing failed for admin GET: ${sanitizeForLog(error)}`,
      );
      stored = [];
      storageUnavailable = true;
    }
    const byKey = new Map(stored.map((entry) => [entry.app.id, entry]));

    const entries = Object.values(MCP_CATALOG)
      .filter(
        (entry) => entry.auth.style === 'oauth' || entry.alsoSupportsOauth,
      )
      .map((entry) => {
        const record = byKey.get(entry.key);
        return {
          catalogKey: entry.key,
          name: entry.label,
          supportsDynamicRegistration:
            entry.supportsDynamicRegistration === true,
          envConfigured: getStaticOauthClient(entry.key) !== null,
          adminConfigured: record !== undefined,
          clientId: record?.app.clientId ?? null,
          hasClientSecret: record?.app.clientSecret !== undefined,
          updatedBy: record?.app.updatedBy ?? null,
          updatedAt: record?.app.updatedAt ?? null,
          etag: record?.etag ?? null,
        };
      });

    return successResponse({
      entries,
      storageUnavailable,
      secretSealingAvailable: isConnectorSecretCryptoConfigured(),
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error, 'agent-access catalog-oauth GET');
  }
}

/**
 * PUT — upsert the record for one catalog key. `If-Match` carries the CAS
 * etag when updating an existing record; omit it to create. Secret
 * semantics match the connectors route: omitted keeps, '' clears, a value
 * reseals (under the catalog key, which is the record id).
 */
export async function PUT(req: NextRequest) {
  try {
    const gate = await requireGlobalAdmin();
    if (gate instanceof Response) return gate;

    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return badRequestResponse('Invalid catalog OAuth app payload');
    }
    const { catalogKey, clientId } = parsed.data;
    if (!oauthCapableCatalogKeys().has(catalogKey)) {
      return badRequestResponse(
        'Unknown or non-OAuth catalog key',
        sanitizeForLog(catalogKey),
      );
    }

    const ifMatch = req.headers.get('if-match');
    if (ifMatch !== null && !STRONG_ETAG_REGEX.test(ifMatch)) {
      return badRequestResponse('If-Match must be a strong ETag');
    }

    const storage = createAgentAccessBlobStorage();
    const existing = await readCatalogOauthApp(storage, catalogKey);
    if (existing !== null && ifMatch === null) {
      return errorResponse(
        'This catalog key already has a record; send If-Match to update it',
        409,
        undefined,
        'CATALOG_OAUTH_EXISTS',
      );
    }

    let sealedSecret = existing?.app.clientSecret;
    if (parsed.data.clientSecret !== undefined) {
      if (parsed.data.clientSecret.trim() === '') {
        sealedSecret = undefined;
      } else {
        if (!isConnectorSecretCryptoConfigured()) {
          return errorResponse(
            'Secret sealing is not configured on this deployment (AUTH_SECRET missing)',
            503,
            undefined,
            'CONNECTOR_SECRETS_UNCONFIGURED',
          );
        }
        sealedSecret = sealConnectorSecret(
          catalogKey,
          parsed.data.clientSecret,
        );
      }
    }

    const now = new Date().toISOString();
    const app: CatalogOauthApp = {
      version: 1,
      id: catalogKey,
      clientId,
      clientSecret: sealedSecret,
      createdBy: existing?.app.createdBy ?? gate.userMail,
      createdAt: existing?.app.createdAt ?? now,
      updatedBy: gate.userMail,
      updatedAt: now,
    };

    let etag: string;
    try {
      etag = await writeCatalogOauthApp(storage, app, ifMatch);
    } catch (error) {
      if (error instanceof AgentAccessConflictError) {
        return errorResponse(
          'The record changed since you loaded it; reload and retry',
          412,
          undefined,
          'CATALOG_OAUTH_CONFLICT',
        );
      }
      throw error;
    }

    AgentAccessService.getInstance().invalidate();
    const canonicalKey = canonicalAgentKey(CATALOG_OAUTH_SOURCE, catalogKey);
    auditAdminWrite('catalog-oauth-upsert', canonicalKey, gate.userMail);
    appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      app,
      updatedBy: gate.userMail,
      updatedAt: now,
    });

    return successResponse({
      catalogKey,
      etag,
      hasClientSecret: sealedSecret !== undefined,
    });
  } catch (error) {
    return handleApiError(error, 'agent-access catalog-oauth PUT');
  }
}

/** DELETE ?catalogKey= — removes the record; env vars become live again. */
export async function DELETE(req: NextRequest) {
  try {
    const gate = await requireGlobalAdmin();
    if (gate instanceof Response) return gate;

    const catalogKey = req.nextUrl.searchParams.get('catalogKey')?.trim();
    if (!catalogKey) return badRequestResponse('catalogKey is required');
    const ifMatch = req.headers.get('if-match');
    if (ifMatch === null || !STRONG_ETAG_REGEX.test(ifMatch)) {
      return badRequestResponse('If-Match must be a strong ETag');
    }

    let removed: boolean;
    try {
      removed = await deleteCatalogOauthApp(
        createAgentAccessBlobStorage(),
        catalogKey,
        ifMatch,
      );
    } catch (error) {
      if (error instanceof AgentAccessConflictError) {
        return errorResponse(
          'The record changed since you loaded it; reload and retry',
          412,
          undefined,
          'CATALOG_OAUTH_CONFLICT',
        );
      }
      throw error;
    }
    if (!removed) return notFoundResponse('Catalog OAuth app');

    AgentAccessService.getInstance().invalidate();
    const now = new Date().toISOString();
    const canonicalKey = canonicalAgentKey(CATALOG_OAUTH_SOURCE, catalogKey);
    auditAdminWrite('catalog-oauth-delete', canonicalKey, gate.userMail);
    appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      app: null,
      updatedBy: gate.userMail,
      updatedAt: now,
    });

    return successResponse({ catalogKey, deleted: true });
  } catch (error) {
    return handleApiError(error, 'agent-access catalog-oauth DELETE');
  }
}
