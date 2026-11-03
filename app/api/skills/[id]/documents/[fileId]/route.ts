import { NextRequest, NextResponse } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  readSkill,
} from '@/lib/services/agentAccess/accessRulesStore';
import { SKILL_SOURCE } from '@/lib/services/agentAccess/types';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import { orgSkillsAvailable } from '@/lib/services/skills/skillCatalog';
import { readSkillOriginal } from '@/lib/services/skills/skillDocumentStore';
import { SkillIdSchema } from '@/lib/services/skills/types';

import {
  handleApiError,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/** Source downloads recheck current skill access and manifest membership on every request. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; fileId: string }> },
) {
  try {
    if (!orgSkillsAvailable()) return notFoundResponse('Resource');
    const session = await auth();
    if (!session?.user) return unauthorizedResponse();
    const { id, fileId } = await context.params;
    if (!SkillIdSchema.safeParse(id).success || !/^[a-f0-9-]{36}$/.test(fileId))
      return notFoundResponse('Resource');
    await resolveUserGroupIds(request, session);
    const service = AgentAccessService.getInstance();
    await service.ensureFresh();
    if (
      service.evaluateAccess({
        userMail: session.user.mail ?? undefined,
        source: SKILL_SOURCE,
        agentName: id,
      }).decision !== 'allow'
    )
      return notFoundResponse('Resource');
    const storage = createAgentAccessBlobStorage();
    const stored = await readSkill(storage, id);
    const document = stored?.skill.documents.find(
      (doc) => doc.fileId === fileId,
    );
    if (!document || stored?.skill.activation === 'off')
      return notFoundResponse('Resource');
    const bytes = await readSkillOriginal(storage, id, fileId, request.signal);
    if (!bytes) return notFoundResponse('Resource');
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return handleApiError(error, 'Could not download skill resource');
  }
}
