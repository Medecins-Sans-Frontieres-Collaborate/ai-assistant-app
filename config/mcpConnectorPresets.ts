/**
 * Starting points for admin-authored MCP connectors.
 *
 * These are NOT catalog entries: every one has a per-tenant URL, which is
 * exactly why they cannot live in MCP_CATALOG (whose `url` is a fixed string
 * shared by every deployment). A preset only prefills the connector form —
 * the admin still supplies the account id or hostname, and the saved record
 * is an ordinary connector afterwards.
 *
 * `urlTemplate` carries a `{placeholder}` the admin replaces. Validation is
 * deliberately left to the server (https + public-shaped host at write time):
 * a preset is a convenience, never a trust boundary.
 */
export interface McpConnectorPreset {
  key: string;
  label: string;
  /** Contains a single {placeholder} token for the tenant-specific part. */
  urlTemplate: string;
  /** What the admin must substitute, e.g. 'accountid'. */
  placeholder: string;
  transport: 'streamable-http' | 'sse';
  authStyle: 'none' | 'bearer' | 'oauth';
  description: string;
  tokenHelpUrl?: string;
  /** Shown in the editor: what the admin has to set up at the vendor first. */
  setupHint: string;
}

export const MCP_CONNECTOR_PRESETS: McpConnectorPreset[] = [
  {
    key: 'netsuite',
    label: 'NetSuite',
    // The account id is part of the HOSTNAME, so every customer's endpoint
    // differs. https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_4160616848.html
    urlTemplate:
      'https://{accountid}.suitetalk.api.netsuite.com/services/mcp/v1/all',
    placeholder: 'accountid',
    transport: 'streamable-http',
    // OAuth 2.0 authorization code + PKCE against a NetSuite integration
    // record. Administrator roles are blocked by NetSuite itself.
    authStyle: 'oauth',
    description: 'Query and update NetSuite records.',
    setupHint:
      'Create an integration record in NetSuite with OAuth 2.0 enabled, then paste its client id and secret below.',
  },
  {
    key: 'matomo',
    label: 'Matomo',
    // Self-hosted or Matomo Cloud — either way the host is the customer's.
    // https://matomo.org/faq/how-to/how-to-configure-the-matomo-mcp-server/
    urlTemplate:
      'https://{your-matomo-host}/index.php?module=API&method=McpServer.mcp&format=mcp',
    placeholder: 'your-matomo-host',
    transport: 'streamable-http',
    // Matomo's own token_auth, pasted per user.
    authStyle: 'bearer',
    description: 'Query Matomo analytics reports.',
    setupHint:
      'Enable the McpServer plugin in Matomo (bundled on Matomo Cloud, installed manually on-premise). Each user pastes their own auth token.',
  },
];
