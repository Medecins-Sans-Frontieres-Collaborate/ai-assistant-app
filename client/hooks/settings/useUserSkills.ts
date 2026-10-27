/**
 * The skills THIS user may invoke (docs/SKILLS_DESIGN.md §5.1): metadata
 * from GET /api/skills, feeding the composer's skill picker. Empty when the
 * feature is off or nothing is visible — the picker then renders nothing.
 */
import { useQuery } from '@tanstack/react-query';

import type { SkillActivation } from '@/lib/services/skills/types';

import { unwrapApiData } from './useAgentAccessAdmin';

import { useSettingsStore } from '@/client/stores/settingsStore';

export interface UserSkillEntry {
  id: string;
  name: string;
  description: string;
  activation: SkillActivation;
  personal?: boolean;
  applyToAgents?: boolean;
}

export function useUserSkills() {
  const personal = useSettingsStore((state) => state.userSkills);
  const query = useQuery<{ skills: UserSkillEntry[]; enabled: boolean }>({
    queryKey: ['user-skills'],
    queryFn: async () => {
      const response = await fetch('/api/skills');
      if (!response.ok) {
        throw new Error(`Failed to fetch skills: ${response.status}`);
      }
      return unwrapApiData<{ skills: UserSkillEntry[]; enabled: boolean }>(
        await response.json(),
      );
    },
    staleTime: 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
  return {
    ...query,
    skillsEnabled: query.data?.enabled === true,
    data: query.data
      ? [
          ...query.data.skills,
          ...(query.data.enabled
            ? personal
                .filter((skill) => skill.enabled && skill.activation !== 'off')
                .map((skill) => ({
                  id: `user:${skill.id}`,
                  name: skill.name,
                  description: skill.description,
                  activation: skill.activation,
                  personal: true,
                  applyToAgents: false,
                }))
            : []),
        ]
      : undefined,
  };
}
