import { redirect } from 'next/navigation';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { canEditKey } from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  FORM_TEMPLATE_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import { FormTemplateAdminEditor } from '@/components/AgentAccess/FormTemplates/FormTemplateAdminEditor';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * Full-page editor for one admin form template. Same gate as the map
 * dataset editor: area gate plus a per-key check so a local admin only opens
 * templates delegated to them (the API enforces the same).
 */
export default async function FormTemplateAdminPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!env.AGENT_ACCESS_CONTROL_ENABLED) {
    redirect('/');
  }

  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  const { id } = await params;
  const service = AgentAccessService.getInstance();
  await service.ensureFresh();
  const { config } = service.getSnapshot();
  const status = resolveAdminStatus(session.user, config);
  if (!status.isGlobalAdmin && !status.isLocalAdmin) {
    redirect('/');
  }
  if (!canEditKey(status, canonicalAgentKey(FORM_TEMPLATE_SOURCE, id))) {
    redirect('/');
  }

  return <FormTemplateAdminEditor templateId={id} />;
}
