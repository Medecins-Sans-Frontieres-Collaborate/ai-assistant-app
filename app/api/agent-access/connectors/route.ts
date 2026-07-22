import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredMcpConnector,
  createAgentAccessBlobStorage,
  deleteConnector,
  listAllConnectors,
  readConfig,
  readConnector,
  writeConnector,
  writeConnectorHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  ALL_AGENT_KEYS,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import {
  STRONG_ETAG_REGEX,
  auditAdminWrite,
  canEditKey,
  delegateToCreator,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  isConnectorSecretCryptoConfigured,
  sealConnectorSecret,
} from '@/lib/services/agentAccess/connectorSecretCrypto';
import {
  AgentAccessConfig,
  MCP_CONNECTOR_SOURCE,
  McpConnector,
  McpConnectorHistoryEntry,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import { isHttpsPublicShapedUrl } from '@/lib/services/mcp/mcpUrlGuard';

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
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * GET/POST/PUT/DELETE /api/agent-access/connectors — admin CRUD for
 * admin-authored MCP connectors (tenant-specific server URLs the compile-time
 * catalog cannot express). 404 while the feature is disabled. Any admin
 * (global or local) may create; edits and deletes are authorized per
 * canonical key (`mcp-connector::<id>`), exactly like rules and prompt agents.
 *
 * Two properties specific to connectors:
 *
 * 1. The URL is validated as https + public-shaped at WRITE time. Connectors
 *    resolve as trusted (skipping the per-request DNS guard), and the tool
 *    loop fetches them from the app's own network position — so a connector
 *    pointing at loopback or link-local would be a genuine SSRF primitive.
 * 2. The OAuth client secret is sealed before it ever reaches storage, and is
 *    NEVER echoed back: reads return `hasClientSecret` only. When the
 *    deployment has no AUTH_SECRET there is nowhere safe to put it, so the
 *    oauth style is refused outright rather than silently downgraded.
 */

/**
 * WRITE-side schema — stricter than the shared read schema in types.ts (which
 * must keep accepting every already-persisted blob). Trims stored values
 * clean; size caps bound admin-supplied payloads.
 */
const connectorFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(300).default(''),
    url: z.string().trim().min(1).max(2000),
    transport: z.enum(['streamable-http', 'sse']).default('streamable-http'),
    authStyle: z.enum(['none', 'bearer', 'oauth']),
    tokenHelpUrl: z.string().trim().max(2000).optional(),
    oauthClientId: z.string().trim().max(500).optional(),
    /**
     * Plaintext, inbound only. Omitted on update = keep the stored secret;
     * empty string = clear it. Never present in any response.
     */
    oauthClientSecret: z.string().max(2000).optional(),
    oauthScopes: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  })
  .strict();

const putBodySchema = connectorFieldsSchema.extend({
  id: z.string().trim().min(1).max(100),
});

/**
 * Ids are server-generated, so a client-supplied one only ever needs to be
 * recognized — not parsed. Enforcing the exact shape keeps arbitrary strings
 * out of `connectorBlobPath` (Azure blob names are literal, so `../` is not
 * traversal, but nothing good comes of an id that isn't one of ours).
 */
const CONNECTOR_ID_PATTERN = /^connector-[a-f0-9]{12}$/;

/**
 * Shape a stored connector for an admin client. The sealed secret is replaced
 * by a boolean: an admin may know whether one is set, never what it is.
 */
function toAdminView(connector: McpConnector) {
  const { oauthClientSecret, ...rest } = connector;
  return { ...rest, hasClientSecret: oauthClientSecret !== undefined };
}

/**
 * Cross-field validation the zod schema can't express. Returns an error
 * message, or null when the payload is coherent.
 */
function validateConnectorFields(
  fields: z.infer<typeof connectorFieldsSchema>,
  { isCreate }: { isCreate: boolean },
): string | null {
  if (!isHttpsPublicShapedUrl(fields.url)) {
    return 'url must be an https URL pointing at a public host';
  }
  if (fields.tokenHelpUrl && !isHttpsPublicShapedUrl(fields.tokenHelpUrl)) {
    return 'tokenHelpUrl must be an https URL pointing at a public host';
  }

  if (fields.authStyle !== 'oauth') {
    if (fields.oauthClientId || fields.oauthClientSecret) {
      return 'oauthClientId/oauthClientSecret are only valid for the oauth auth style';
    }
    if (fields.oauthScopes.length > 0) {
      return 'oauthScopes is only valid for the oauth auth style';
    }
    return null;
  }

  // oauth from here down.
  if (!isConnectorSecretCryptoConfigured()) {
    return 'OAuth connectors are unavailable: this deployment has no AUTH_SECRET to seal client secrets with';
  }
  if (!fields.oauthClientId?.trim()) {
    return 'oauthClientId is required for the oauth auth style';
  }
  // On create the secret must be supplied outright; on update, omitting it
  // means "keep the stored one", which the caller verifies actually exists.
  if (isCreate && !fields.oauthClientSecret?.trim()) {
    return 'oauthClientSecret is required when creating an oauth connector';
  }
  return null;
}

/**
 * History is the durable audit trail but blob storage has no transactions: by
 * the time the entry is written the connector mutation has already landed, so
 * a history failure must not convert a successful save into a client-visible
 * error (a retry with the same If-Match would then 409). Log loudly instead.
 */
async function appendHistoryBestEffort(
  entry: McpConnectorHistoryEntry,
): Promise<void> {
  try {
    await writeConnectorHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

/**
 * Best-effort removal of a just-created connector whose delegation could not
 * be recorded — a local admin must never end up owning a connector they
 * cannot edit. Returns whether it is actually gone: on false the blob
 * persists WITHOUT delegation (visible under deny-list semantics, editable by
 * nobody but global admins) and the caller must say so instead of claiming a
 * rollback that did not happen.
 */
async function rollbackCreate(
  id: string,
  etag: string,
  canonicalKey: string,
  userMail: string,
): Promise<boolean> {
  try {
    // A false return means the blob was already absent — the rollback's goal
    // is met either way.
    await deleteConnector(createAgentAccessBlobStorage(), id, etag);
    auditAdminWrite('connector-delete', canonicalKey, userMail);
    return true;
  } catch (error) {
    console.error(
      `[agent-access-admin] ROLLBACK DELETE FAILED — connector id=${sanitizeForLog(id)} key=${sanitizeForLog(canonicalKey)} still exists WITHOUT delegation and needs global-admin cleanup: ${sanitizeForLog(error)}`,
    );
    return false;
  }
}

function conflictResponse(service: AgentAccessService) {
  // Another replica just won the CAS — refresh this replica's cached state
  // promptly instead of serving it stale for ≤60s.
  service.invalidate();
  return errorResponse(
    'Connector was modified by another admin; reload and retry',
    409,
    undefined,
    'AGENT_ACCESS_CONFLICT',
  );
}

export async function GET() {
  // Feature flag BEFORE auth: a disabled deployment must answer 404 to
  // everyone, exactly like a route that does not exist.
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    // Read storage DIRECTLY (like the rules GET), not the ≤60s-stale service
    // snapshot: the etags echoed here feed the If-Match CAS, so after a 409
    // the UI's reload must observe the other replica's write immediately.
    let stored: StoredMcpConnector[] = [];
    let config: AgentAccessConfig | null = null;
    let connectorsUnavailable = false;
    let fetchedAt: number | null = null;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listed, configResult] = await Promise.all([
        listAllConnectors(storage),
        readConfig(storage),
      ]);
      stored = listed;
      config = configResult?.config ?? null;
      fetchedAt = Date.now();
    } catch (error) {
      // Same contract as the rules listing: storage outage → empty listing
      // flagged connectorsUnavailable, not a 500.
      console.error(
        `[agent-access-admin] direct connectors read failed: ${sanitizeForLog(error)}`,
      );
      connectorsUnavailable = true;
      // The direct read exists for CAS-fresh etags, not authorization: when it
      // fails, authorize from the service's ≤60s-stale last-known-good config
      // so local admins receive the same degraded 200 as global admins instead
      // of a false 403. A cold replica with no snapshot still fails closed.
      config = service.getSnapshot().config;
    }

    const status = resolveAdminStatus(session.user.mail, config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    const visible =
      status.editableAgentKeys === ALL_AGENT_KEYS
        ? stored
        : stored.filter((entry) => canEditKey(status, entry.canonicalKey));

    return successResponse({
      connectors: visible.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        connector: toAdminView(entry.connector),
        etag: entry.etag,
      })),
      connectorsUnavailable,
      // Lets the editor disable the oauth style with an explanation instead of
      // offering a choice the server will reject.
      secretSealingAvailable: isConnectorSecretCryptoConfigured(),
      fetchedAt,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list connectors');
  }
}

export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  // No Graph mail → cannot be an admin (both admin registries are keyed on
  // mail), and createdBy would be unattributable.
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = connectorFieldsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid connector body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }
  const fieldError = validateConnectorFields(parsed.data, { isCreate: true });
  if (fieldError) {
    // A missing sealing key is a deployment-configuration gap, not a bad
    // request — 503 with a distinct code so the UI can explain it.
    if (
      !isConnectorSecretCryptoConfigured() &&
      parsed.data.authStyle === 'oauth'
    ) {
      return errorResponse(
        fieldError,
        503,
        undefined,
        'CONNECTOR_SECRETS_UNCONFIGURED',
      );
    }
    return badRequestResponse(fieldError);
  }

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    // Any admin may create — including a local admin with zero delegated keys
    // (the created connector is auto-delegated to them below).
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    // Server-generated immutable id; the canonical key, blob path, and the
    // sealed secret's AAD all hang off it, so renames never orphan rules or
    // delegations and a secret can never be replayed onto another connector.
    const id = `connector-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const canonicalKey = canonicalAgentKey(MCP_CONNECTOR_SOURCE, id);
    const now = new Date().toISOString();
    const connector: McpConnector = {
      version: 1,
      id,
      name: parsed.data.name,
      description: parsed.data.description,
      url: parsed.data.url,
      transport: parsed.data.transport,
      authStyle: parsed.data.authStyle,
      tokenHelpUrl: parsed.data.tokenHelpUrl,
      oauthClientId: parsed.data.oauthClientId,
      oauthClientSecret:
        parsed.data.authStyle === 'oauth' && parsed.data.oauthClientSecret
          ? sealConnectorSecret(id, parsed.data.oauthClientSecret)
          : undefined,
      oauthScopes: parsed.data.oauthScopes,
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    };

    // writeConnector derives the blob path from the record's own id, so the
    // key audited/delegated below is exactly the key being written.
    const etag = await writeConnector(
      createAgentAccessBlobStorage(),
      connector,
      null,
    );
    service.invalidate();
    auditAdminWrite('connector-upsert', canonicalKey, userMail);

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
          // The orphan is live: with no rule it is visible to every user
          // (deny-list semantics) and no local admin can edit or delete it.
          // Record it in the durable audit trail (creation history was not yet
          // written) and tell the client exactly what needs cleanup — never
          // claim a rollback that did not happen.
          await appendHistoryBestEffort({
            version: 1,
            canonicalKey,
            action: 'upsert',
            connector,
            updatedBy: userMail,
            updatedAt: now,
          });
          return errorResponse(
            `Could not record delegation AND rollback failed: connector ${id} still exists without delegation and needs global-admin cleanup`,
            503,
          );
        }
        return errorResponse(
          'Could not record delegation; connector creation rolled back',
          503,
        );
      }
      // The config just changed too — admin status snapshots must refetch.
      service.invalidate();
    }

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      connector,
      updatedBy: userMail,
      updatedAt: now,
    });

    return successResponse({
      connector: toAdminView(connector),
      etag,
      canonicalKey,
    });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to create connector');
  }
}

export async function PUT(request: NextRequest) {
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
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid connector body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }
  const fieldError = validateConnectorFields(parsed.data, { isCreate: false });
  if (fieldError) {
    if (
      !isConnectorSecretCryptoConfigured() &&
      parsed.data.authStyle === 'oauth'
    ) {
      return errorResponse(
        fieldError,
        503,
        undefined,
        'CONNECTOR_SECRETS_UNCONFIGURED',
      );
    }
    return badRequestResponse(fieldError);
  }

  if (!CONNECTOR_ID_PATTERN.test(parsed.data.id)) {
    return badRequestResponse('id is not a valid connector id');
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(MCP_CONNECTOR_SOURCE, parsed.data.id);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this connector key');
    }

    // Updates are keyed on the body id — ids are immutable and
    // server-generated, so a PUT can never mint a new record.
    const existing = await readConnector(
      createAgentAccessBlobStorage(),
      parsed.data.id,
    );
    if (existing === null) {
      return notFoundResponse('Connector');
    }

    // Secret handling: omitted → keep what is stored; empty string → clear;
    // non-empty → reseal. Resealing under the record's own id keeps the AAD
    // binding correct.
    let sealedSecret = existing.connector.oauthClientSecret;
    if (parsed.data.authStyle !== 'oauth') {
      sealedSecret = undefined;
    } else if (parsed.data.oauthClientSecret !== undefined) {
      sealedSecret = parsed.data.oauthClientSecret.trim()
        ? sealConnectorSecret(parsed.data.id, parsed.data.oauthClientSecret)
        : undefined;
    }
    if (parsed.data.authStyle === 'oauth' && !sealedSecret) {
      return badRequestResponse(
        'oauthClientSecret is required: none is stored for this connector',
      );
    }

    const now = new Date().toISOString();
    // Spread preserves id/createdBy/createdAt from the stored record.
    const connector: McpConnector = {
      ...existing.connector,
      name: parsed.data.name,
      description: parsed.data.description,
      url: parsed.data.url,
      transport: parsed.data.transport,
      authStyle: parsed.data.authStyle,
      tokenHelpUrl: parsed.data.tokenHelpUrl,
      oauthClientId:
        parsed.data.authStyle === 'oauth'
          ? parsed.data.oauthClientId
          : undefined,
      oauthClientSecret: sealedSecret,
      oauthScopes: parsed.data.oauthScopes,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writeConnector(
      createAgentAccessBlobStorage(),
      connector,
      ifMatchEtag,
    );
    service.invalidate();
    auditAdminWrite('connector-upsert', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      connector,
      updatedBy: userMail,
      updatedAt: now,
    });

    return successResponse({
      connector: toAdminView(connector),
      etag,
      canonicalKey,
    });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to update connector');
  }
}

export async function DELETE(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  const id = request.nextUrl.searchParams.get('id');
  if (!id?.trim()) {
    return badRequestResponse('id query param is required');
  }
  if (!CONNECTOR_ID_PATTERN.test(id.trim())) {
    return badRequestResponse('id is not a valid connector id');
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(MCP_CONNECTOR_SOURCE, id);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this connector key');
    }

    // Delegation keys referencing this connector are left dangling in config
    // (render as unknown keys in the admin UI) — documented and acceptable,
    // matching prompt-agent deletes.
    const deleted = await deleteConnector(
      createAgentAccessBlobStorage(),
      id.trim(),
      ifMatchEtag,
    );
    if (!deleted) {
      return notFoundResponse('Connector');
    }
    service.invalidate();
    auditAdminWrite('connector-delete', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      connector: null,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    });

    return successResponse({ canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to delete connector');
  }
}
