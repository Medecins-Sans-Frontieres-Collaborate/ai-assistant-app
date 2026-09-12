import { useQuery } from '@tanstack/react-query';

/** One admin-curated form template this user may attach. Metadata only. */
export interface AvailableFormTemplate {
  id: string;
  name: string;
  description: string;
  language?: string;
  fieldCount: number;
  fillMode: 'docx-controls' | 'docx-anchored' | 'pdf-acroform' | 'none';
  updatedAt: string;
}

interface TemplatesResponse {
  success: boolean;
  data?: { templates: AvailableFormTemplate[] };
}

/**
 * Admin-curated form templates available to the signed-in user
 * (GET /api/form-templates). Access rules are applied server-side.
 * FAILS CLOSED: an error simply lists nothing — the load route re-checks
 * access anyway. Short TTL because entitlement changes when an admin edits
 * a rule, and the "template updated" notice compares against `updatedAt`.
 */
export function useAvailableFormTemplates() {
  const { data, isLoading } = useQuery({
    queryKey: ['available-form-templates'],
    queryFn: async (): Promise<AvailableFormTemplate[]> => {
      const response = await fetch('/api/form-templates');
      if (!response.ok) {
        throw new Error(`Failed to load form templates: ${response.status}`);
      }
      const json: TemplatesResponse = await response.json();
      return json.data?.templates ?? [];
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  return { templates: data ?? [], isLoadingTemplates: isLoading };
}
