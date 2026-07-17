import { useQuery } from '@tanstack/react-query';

import { ensureFreshOauthToken } from '@/client/services/mcp/mcpOauth';

import { McpToolSummary } from '@/types/mcp';

import { McpServerConfig } from '@/client/stores/settingsStore';

interface McpToolsResponse {
  success: boolean;
  data?: {
    serverLabel: string;
    tools: McpToolSummary[];
    cached: boolean;
  };
  error?: string;
  code?: string;
}

/**
 * Lists the tools of an already-connected MCP server (Connectors settings
 * rows show "N tools available"). Modeled on useFoundryAgents: long stale
 * time, graceful degradation to an empty list on failure.
 *
 * POSTs because the auth token rides in the body — it must never appear in a
 * URL (query strings land in server access logs).
 */
export function useMcpTools(server: McpServerConfig | undefined) {
  const { data, isLoading, isError } = useQuery({
    // Token changes flip the key without embedding the secret in the key.
    queryKey: [
      'mcp-tools',
      server?.id,
      server?.catalogKey ?? server?.url,
      server?.authMode === 'oauth'
        ? (server.oauth?.accessToken?.length ?? 0)
        : server?.authToken
          ? server.authToken.length
          : 0,
    ],
    queryFn: async (): Promise<{ tools: McpToolSummary[] }> => {
      if (!server) return { tools: [] };
      // OAuth servers refresh through the proxy first; without a live token
      // there is nothing to list.
      let effectiveToken: string | undefined;
      if (server.authMode === 'oauth') {
        effectiveToken = await ensureFreshOauthToken(server);
        if (!effectiveToken) return { tools: [] };
      } else if (server.authMode !== 'none') {
        effectiveToken = server.authToken;
      }
      const response = await fetch('/api/mcp/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: {
            id: server.id,
            name: server.name,
            ...(server.catalogKey
              ? { catalogKey: server.catalogKey }
              : { url: server.url }),
            ...(effectiveToken ? { authToken: effectiveToken } : {}),
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`Failed to list MCP tools: ${response.status}`);
      }
      const json: McpToolsResponse = await response.json();
      return { tools: json.data?.tools ?? [] };
    },
    enabled: !!server,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return {
    tools: data?.tools ?? [],
    isLoadingTools: isLoading,
    toolsError: isError,
  };
}
