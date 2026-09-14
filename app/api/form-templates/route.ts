import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  listAllFormTemplates,
} from '@/lib/services/agentAccess/accessRulesStore';
import { FORM_TEMPLATE_SOURCE } from '@/lib/services/agentAccess/types';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import { parseTemplate } from '@/lib/services/workflows/form/templateSchema';
import { isWorkflowEnabled } from '@/lib/services/workflows/policy/guard';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/form-templates — the admin-curated form templates THIS user may
 * use, metadata only (the template body comes from /api/form-templates/[id]
 * when the user attaches it). Empty list — not 403 — when the feature is
 * off or nothing is shared: "no templates" is a normal state.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const service = AgentAccessService.getInstance();
  // The workflow kill switch hides the templates too: an admin who switched
  // the workflow off must not leave its shared templates downloadable.
  if (!service.isEnabled() || !(await isWorkflowEnabled('form-fill'))) {
    return successResponse({ templates: [] });
  }

  // Group warm-up MUST precede evaluateAccess (group rules read the cache
  // synchronously). Never throws.
  await resolveUserGroupIds(request, session);

  try {
    await service.ensureFresh();
    const userMail = session.user.mail ?? undefined;
    const stored = await listAllFormTemplates(createAgentAccessBlobStorage());
    const templates = stored
      .filter(
        (entry) =>
          service.evaluateAccess({
            userMail,
            source: FORM_TEMPLATE_SOURCE,
            agentName: entry.record.id,
          }).decision === 'allow',
      )
      .map((entry) => {
        const parsed = parseTemplate(entry.record.template);
        return {
          id: entry.record.id,
          name: entry.record.name,
          description: entry.record.description,
          language: parsed.ok ? parsed.template.language : undefined,
          fieldCount: parsed.ok ? parsed.template.fields.length : 0,
          fillMode: parsed.ok
            ? (parsed.template.original?.fillMode ?? 'none')
            : 'none',
          valid: parsed.ok,
          updatedAt: entry.record.updatedAt,
        };
      })
      // An incoherent record cannot be attached; hide it like a denied one.
      .filter((t) => t.valid)
      .map(({ valid: _valid, ...rest }) => {
        void _valid;
        return rest;
      });
    return successResponse({ templates });
  } catch (error) {
    return handleApiError(error, 'Failed to list form templates');
  }
}
