import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { MCP_CONNECTOR_SOURCE } from '@/lib/services/agentAccess/types';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/mcp/connectors — the admin-authored connectors THIS user may use.
 *
 * The end-user counterpart to /api/agent-access/connectors (which is admin
 * CRUD). Two deliberate omissions from the payload:
 *
 * - No URL. The client never needs it — resolution is server-side from the
 *   connectorId — so sending it would only widen what a compromised client
 *   can learn about internal tenant endpoints.
 * - No OAuth client id/secret. The browser receives a client id only through
 *   the register route, and only when a flow actually starts.
 *
 * Returns an empty list rather than a 403 when the feature is off or the user
 * is entitled to nothing: "no connectors" is a normal state, not an error.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) {
    return successResponse({ connectors: [] });
  }

  try {
    await service.ensureFresh();
    const userMail = session.user.mail ?? undefined;

    const connectors = service
      .getConnectors()
      .filter(
        (connector) =>
          // Fail closed on 'unavailable' too: listing a connector that chat
          // would then refuse to resolve is a worse experience than omitting
          // it, and the two paths must agree.
          service.evaluateAccess({
            userMail,
            source: MCP_CONNECTOR_SOURCE,
            agentName: connector.id,
          }).decision === 'allow',
      )
      .map((connector) => ({
        id: connector.id,
        name: connector.name,
        description: connector.description,
        authStyle: connector.authStyle,
        tokenHelpUrl: connector.tokenHelpUrl,
        // Whether a "Connect with …" click can succeed: an OAuth connector
        // needs a configured client, otherwise the flow falls back to DCR
        // which most tenant servers do not support.
        oauthAppConfigured:
          connector.authStyle === 'oauth' &&
          connector.oauthClientId !== undefined,
      }));

    return successResponse({ connectors });
  } catch (error) {
    return handleApiError(error, 'Failed to list connectors');
  }
}
