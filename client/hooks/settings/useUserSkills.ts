/**
 * The skills THIS user may invoke (docs/SKILLS_DESIGN.md §5.1): metadata
 * from GET /api/skills, feeding the composer's skill picker. Empty when
 * nothing is visible — the picker then renders nothing. Personal skills
 * join the list only while the user's automatic-selection toggle is on,
 * since that is the only way they are ever sent.
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
  const autoEnabled = useSettingsStore((state) => state.skillsAutoEnabled);
  const query = useQuery<{ skills: UserSkillEntry[] }>({
    queryKey: ['user-skills'],
    queryFn: async () => {
      const response = await fetch('/api/skills');
      if (!response.ok) {
        throw new Error(`Failed to fetch skills: ${response.status}`);
      }
      return unwrapApiData<{ skills: UserSkillEntry[] }>(await response.json());
    },
    staleTime: 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
  return {
    ...query,
    data: query.data
      ? [
          ...query.data.skills,
          ...(autoEnabled
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
