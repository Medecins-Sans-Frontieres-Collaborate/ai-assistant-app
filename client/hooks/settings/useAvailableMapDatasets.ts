import { useQuery } from '@tanstack/react-query';

/** One admin-curated dataset this user may load. Metadata only — the full
 * payload comes from /api/map-datasets/<id> at load time. */
export interface AvailableMapDataset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  featureCount: number;
  connectionCount: number;
  updatedAt: string;
}

interface DatasetsResponse {
  success: boolean;
  data?: { datasets: AvailableMapDataset[] };
}

/**
 * Admin-curated map datasets available to the signed-in user
 * (GET /api/map-datasets). The server has already applied access rules.
 * FAILS CLOSED: an empty list on error simply hides the picker — the load
 * endpoint re-checks access anyway. Short TTL because entitlement changes
 * when an admin edits a rule.
 */
export function useAvailableMapDatasets() {
  const { data, isLoading } = useQuery({
    queryKey: ['available-map-datasets'],
    queryFn: async (): Promise<AvailableMapDataset[]> => {
      const response = await fetch('/api/map-datasets');
      if (!response.ok) {
        throw new Error(`Failed to load datasets: ${response.status}`);
      }
      const json: DatasetsResponse = await response.json();
      return json.data?.datasets ?? [];
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return { datasets: data ?? [], isLoadingDatasets: isLoading };
}
