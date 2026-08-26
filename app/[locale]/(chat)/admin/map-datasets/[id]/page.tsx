import { redirect } from 'next/navigation';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { canEditKey } from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  MAP_DATASET_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import { MapDatasetEditor } from '@/components/AgentAccess/MapDatasets/MapDatasetEditor';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * Full-page curation editor for one admin map dataset. Server component
 * gate mirrors admin/agent-access/page.tsx, plus a per-key check so a local
 * admin can only open datasets delegated to them — the API routes enforce
 * the same, this just avoids serving a page whose every call would 403.
 */
export default async function MapDatasetAdminPage({
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
  if (!canEditKey(status, canonicalAgentKey(MAP_DATASET_SOURCE, id))) {
    redirect('/');
  }

  return <MapDatasetEditor datasetId={id} />;
}
