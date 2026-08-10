import { useQuery } from '@tanstack/react-query';

/** One admin-authored guide this user is permitted to use. Metadata only —
 * the body is fetched on demand from /api/guides/<id> for the viewer. */
export interface AvailableGuide {
  id: string;
  kind: 'style' | 'terminology' | 'compliance' | 'structure' | 'tone';
  name: string;
  description: string;
  languages: string[];
  workflows: Array<'document' | 'translation'>;
  updatedAt: string;
}

interface GuidesResponse {
  success: boolean;
  data?: { guides: AvailableGuide[] };
}

/**
 * Admin-authored workflow guides available to the signed-in user
 * (GET /api/guides). The server has already applied access rules, so
 * everything returned here is usable by this user.
 *
 * FAILS CLOSED: an empty list on error simply shows no guides — the assess
 * route re-checks access anyway, so guessing here would only render
 * checkboxes whose assessment is then rejected. Short TTL for the same
 * reason as useAvailableConnectors: entitlement changes when an admin edits
 * a rule.
 */
export function useAvailableGuides() {
  const { data, isLoading } = useQuery({
    queryKey: ['available-guides'],
    queryFn: async (): Promise<AvailableGuide[]> => {
      const response = await fetch('/api/guides');
      if (!response.ok) {
        throw new Error(`Failed to load guides: ${response.status}`);
      }
      const json: GuidesResponse = await response.json();
      return json.data?.guides ?? [];
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return { guides: data ?? [], isLoadingGuides: isLoading };
}
