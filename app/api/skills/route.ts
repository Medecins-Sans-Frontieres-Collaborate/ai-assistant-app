import { NextRequest } from 'next/server';

import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import {
  getVisibleSkills,
  skillsFeatureEnabled,
} from '@/lib/services/skills/skillCatalog';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/skills — the skills THIS user may use (docs/SKILLS_DESIGN.md).
 *
 * The end-user counterpart to /api/agent-access/skills (admin CRUD). Feeds
 * the composer's skill picker: metadata only — id, name, description,
 * activation — never the instruction body, which is injected server-side by
 * SkillEnricher and has no business in the browser.
 *
 * Returns an empty list rather than a 403 when the feature is off or the
 * user is entitled to nothing: "no skills" is a normal state, not an error.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  if (!skillsFeatureEnabled()) {
    return successResponse({ skills: [], enabled: false });
  }

  // Group-membership warm-up MUST precede the evaluateAccess filter inside
  // getVisibleSkills — group-scoped rules read the cache synchronously.
  // Never throws.
  await resolveUserGroupIds(request, session);

  try {
    const visible = await getVisibleSkills(session.user.mail ?? undefined);

    return successResponse({
      enabled: true,
      skills: visible.map((entry) => ({
        id: entry.skill.id,
        name: entry.skill.name,
        description: entry.skill.description,
        activation: entry.skill.activation,
        applyToAgents: entry.skill.applyToAgents,
      })),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list skills');
  }
}
