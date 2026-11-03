/**
 * Skills are always on. Without agent-access storage there are no
 * organization skills to read or filter, so the visible catalog is the
 * compiled built-ins (minus 'off') — never an empty feature.
 */
import {
  getVisibleSkills,
  orgSkillsAvailable,
} from '@/lib/services/skills/skillCatalog';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/environment', () => ({
  env: { AGENT_ACCESS_CONTROL_ENABLED: false },
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => {
      throw new Error('storage must not be touched without agent access');
    },
  },
}));

describe('skill catalog without agent-access storage', () => {
  it('reports organization skills as unavailable', () => {
    expect(orgSkillsAvailable()).toBe(false);
  });

  it('serves the built-in skills org-wide without reading storage', async () => {
    const visible = await getVisibleSkills('anyone@msf.org');
    expect(visible.map((entry) => entry.skill.id)).toEqual(['platform-help']);
    expect(visible[0].builtin).toBe(true);
  });
});
