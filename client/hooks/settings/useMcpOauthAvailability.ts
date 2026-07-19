import { useQuery } from '@tanstack/react-query';

interface AvailabilityResponse {
  success: boolean;
  data?: { availability: Record<string, boolean> };
}

/**
 * Which curated connectors have a deployment OAuth app configured
 * (GET /api/mcp/oauth/availability). Deployment config, so it's fetched once
 * and effectively never refetched.
 *
 * FAILS OPEN: on a network/API error the map is empty and callers treat an
 * absent key as "available", keeping today's behavior (offer the button, let
 * the flow report the real error). Hiding an affordance on a transient fetch
 * failure would be the worse mistake — it looks like the connector vanished.
 */
export function useMcpOauthAvailability() {
  const { data } = useQuery({
    queryKey: ['mcp-oauth-availability'],
    queryFn: async (): Promise<Record<string, boolean>> => {
      const response = await fetch('/api/mcp/oauth/availability');
      if (!response.ok) {
        throw new Error(
          `Failed to load OAuth availability: ${response.status}`,
        );
      }
      const json: AvailabilityResponse = await response.json();
      return json.data?.availability ?? {};
    },
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return {
    /** True unless the deployment is known to lack an app for this key. */
    isOauthAppAvailable: (catalogKey: string) => data?.[catalogKey] !== false,
  };
}
