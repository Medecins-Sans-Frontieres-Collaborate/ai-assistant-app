import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  readFormTemplate,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  FORM_TEMPLATE_ID_PATTERN,
  FORM_TEMPLATE_SOURCE,
} from '@/lib/services/agentAccess/types';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import { parseTemplate } from '@/lib/services/workflows/form/templateSchema';
import { isWorkflowEnabled } from '@/lib/services/workflows/policy/guard';

import {
  badRequestResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/form-templates/[id] — one admin template in full, for attaching
 * to a form-fill conversation (the snapshot the workspace keeps). A template
 * the user may not use answers the SAME 404 as one that does not exist.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const service = AgentAccessService.getInstance();
  if (!service.isEnabled() || !(await isWorkflowEnabled('form-fill'))) {
    return notFoundResponse('Template');
  }

  await resolveUserGroupIds(request, session);

  const { id } = await params;
  if (!FORM_TEMPLATE_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid form template id');
  }

  try {
    await service.ensureFresh();
    // Access is decided BEFORE the storage read — no existence oracle.
    const decision = service.evaluateAccess({
      userMail: session.user.mail ?? undefined,
      source: FORM_TEMPLATE_SOURCE,
      agentName: id,
    });
    if (decision.decision !== 'allow') return notFoundResponse('Template');

    const stored = await readFormTemplate(createAgentAccessBlobStorage(), id);
    if (stored === null) return notFoundResponse('Template');
    const parsed = parseTemplate(stored.record.template);
    if (!parsed.ok) return notFoundResponse('Template');

    return successResponse({ template: parsed.template });
  } catch (error) {
    return handleApiError(error, 'Failed to load form template');
  }
}
