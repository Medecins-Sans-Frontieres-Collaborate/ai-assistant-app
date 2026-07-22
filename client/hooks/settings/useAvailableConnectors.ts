import { useQuery } from '@tanstack/react-query';

/** One admin-authored connector this user is permitted to use. */
export interface AvailableConnector {
  id: string;
  name: string;
  description: string;
  authStyle: 'none' | 'bearer' | 'oauth';
  tokenHelpUrl?: string;
  /** An OAuth connector with no configured app cannot start a flow. */
  oauthAppConfigured: boolean;
}

interface ConnectorsResponse {
  success: boolean;
  data?: { connectors: AvailableConnector[] };
}

/**
 * Admin-authored connectors available to the signed-in user
 * (GET /api/mcp/connectors). The server has already applied access rules, so
 * everything returned here is usable by this user.
 *
 * FAILS CLOSED, unlike useMcpOauthAvailability: an empty list on error simply
 * shows no admin connectors, whereas guessing would render rows whose connect
 * button cannot work. The TTL is short (not the 24h used for deployment
 * config) because entitlement changes when an admin edits a rule, and a user
 * waiting a day to see a newly-granted connector would look broken.
 */
export function useAvailableConnectors() {
  const { data, isLoading } = useQuery({
    queryKey: ['mcp-available-connectors'],
    queryFn: async (): Promise<AvailableConnector[]> => {
      const response = await fetch('/api/mcp/connectors');
      if (!response.ok) {
        throw new Error(`Failed to load connectors: ${response.status}`);
      }
      const json: ConnectorsResponse = await response.json();
      return json.data?.connectors ?? [];
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return { connectors: data ?? [], isLoadingConnectors: isLoading };
}
