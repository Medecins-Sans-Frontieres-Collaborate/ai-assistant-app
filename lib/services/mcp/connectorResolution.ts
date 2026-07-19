/**
 * Chat-time resolution of admin-authored MCP connectors.
 *
 * This is the enforcement point. Curated catalog entries are safe to resolve
 * from a client-sent key alone because every user may use them; connectors are
 * NOT — they are scoped by access rules, so the entitlement must be re-checked
 * on every request that could reach one. Filtering in the settings UI would be
 * no protection at all: MCP server entries live in localStorage, so a stale or
 * edited blob would otherwise still resolve to a live URL.
 *
 * Fails closed in every ambiguous case — feature off, connector unknown, rules
 * unavailable, no Graph mail on a restricted connector — because the failure
 * mode of an over-permissive resolve is "this user's request reaches a server
 * they were not entitled to", while the failure mode of an over-strict one is
 * "the connector is temporarily missing from their list".
 */
import { Session } from 'next-auth';

import {
  AgentAccessService,
  emitAccessAudit,
} from '@/lib/services/agentAccess/AgentAccessService';
import {
  MCP_CONNECTOR_SOURCE,
  McpConnector,
} from '@/lib/services/agentAccess/types';

import { McpCatalogAuth, ResolvedMcpServer } from '@/config/mcpCatalog';

/** Connector auth style → the shape the MCP client consumes. */
function toCatalogAuth(connector: McpConnector): McpCatalogAuth {
  switch (connector.authStyle) {
    case 'none':
      return { style: 'none' };
    case 'bearer':
      return { style: 'bearer' };
    case 'oauth':
      return {
        style: 'oauth',
        scopes:
          connector.oauthScopes.length > 0 ? connector.oauthScopes : undefined,
      };
  }
}

/**
 * Builds the `resolveConnector` callback for resolveMcpServers, bound to this
 * user. Awaits the access snapshot once; the returned function is synchronous
 * and may be called per entry.
 *
 * Returns a resolver that always denies when the feature is disabled — that is
 * not a degradation, it is the correct answer: with no rules engine there is
 * no way to know who may use a connector, so nobody may.
 */
export async function createConnectorResolver(
  session: Session | null,
): Promise<(connectorId: string) => ResolvedMcpServer | null> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return () => null;

  await service.ensureFresh();
  const userMail = session?.user?.mail ?? undefined;

  return (connectorId: string): ResolvedMcpServer | null => {
    const connector = service.getConnectorById(connectorId);
    if (!connector) return null;

    const decision = service.evaluateAccess({
      userMail,
      // Connectors always resolve their source, so the unresolved-source
      // sweep (semantics #4) never applies here.
      source: MCP_CONNECTOR_SOURCE,
      agentName: connector.id,
    });
    emitAccessAudit({
      userMail,
      agentName: `connector:${connector.id}`,
      source: MCP_CONNECTOR_SOURCE,
      decision: decision.decision,
      reason: decision.reason,
    });
    // 'unavailable' (enabled, but no last-known-good ruleset) denies here.
    // Discovery paths pass through on 'unavailable'; invocation must not, and
    // reaching a connector's URL is invocation.
    if (decision.decision !== 'allow') return null;

    return {
      id: connector.id,
      label: connector.name,
      url: connector.url,
      transport: connector.transport,
      auth: toCatalogAuth(connector),
      // Admin-authored and URL-validated at write time (https + public-shaped
      // host), so the per-request DNS guard is skipped exactly as for catalog
      // entries.
      trusted: true,
    };
  };
}
