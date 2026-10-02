/**
 * The audit trail for analytics: who opened, exported or downloaded what,
 * and who was refused. Server-only.
 *
 * Recorded under the columns the log stream already has — `AgentAccess`
 * events with source `analytics` — because the production ingestion rule
 * drops columns it does not know. Never fails the request it describes.
 */
import { Session } from 'next-auth';

import { getAzureMonitorLogger } from '@/lib/services/observability/AzureMonitorLoggingService';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export type AnalyticsAuditAction = 'download' | 'export' | 'view';

export function auditAnalytics(
  user: Session['user'],
  path: string,
  action: AnalyticsAuditAction,
  decision: 'allow' | 'deny',
  detail: string,
): void {
  console.log(
    `[analytics-audit] action=${action} decision=${decision} detail=${sanitizeForLog(detail)} path=${sanitizeForLog(path)} by=${sanitizeForLog(user.mail ?? user.id)}`,
  );
  void getAzureMonitorLogger()
    .logAgentAccess({
      user,
      agentName: path,
      agentSource: 'analytics',
      decision,
      reason: `${action}:${detail}`,
    })
    .catch(() => undefined);
}
