/**
 * Everything a viewer-side analytics route needs, resolved once per request.
 * Server-only.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import {
  AnalyticsActor,
  FolderIndex,
  indexFolders,
} from '@/lib/services/analytics/access';
import { resolveAnalyticsActor } from '@/lib/services/analytics/actor';
import { analyticsFileId } from '@/lib/services/analytics/deliveryStore';
import { scheduleAnalyticsMaintenance } from '@/lib/services/analytics/maintenance';
import {
  AnalyticsData,
  FileView,
  buildFileViews,
} from '@/lib/services/analytics/viewModel';

export interface AnalyticsRequestContext {
  actor: AnalyticsActor;
  groupsDegraded: boolean;
  data: AnalyticsData;
  deliveryUnavailable: boolean;
  foldersUnavailable: boolean;
  folders: FolderIndex;
  /** Every delivered file, with admin-level detail; filter before returning. */
  files: FileView[];
  now: Date;
}

export async function loadAnalyticsContext(
  request: NextRequest,
  session: Session,
): Promise<AnalyticsRequestContext> {
  const service = AnalyticsService.getInstance();
  const [{ actor, groupsDegraded }] = await Promise.all([
    resolveAnalyticsActor(request, session),
    service.ensureFresh(),
  ]);
  const snapshot = service.getSnapshot();
  const now = new Date();
  const data: AnalyticsData = {
    folders: snapshot.folders,
    policy: snapshot.policy,
    policyUnavailable: snapshot.policyUnavailable,
    state: snapshot.state,
    blobs: snapshot.blobs,
  };
  // Not awaited: validates new deliveries and expires old ones in the
  // background. Nothing in this response depends on it.
  scheduleAnalyticsMaintenance();
  return {
    actor,
    groupsDegraded,
    data,
    deliveryUnavailable: snapshot.deliveryUnavailable,
    foldersUnavailable: snapshot.foldersUnavailable,
    folders: indexFolders(snapshot.folders?.folders),
    files: buildFileViews(data, analyticsFileId, now),
    now,
  };
}
