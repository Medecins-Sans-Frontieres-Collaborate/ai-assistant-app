import { AnalyticsActor } from '@/lib/services/analytics/access';
import { VALIDATOR_VERSION } from '@/lib/services/analytics/fileState';
import {
  AnalyticsFileState,
  AnalyticsFolder,
  DeliveredBlob,
} from '@/lib/services/analytics/types';

export function folder(
  path: string,
  overrides: Partial<AnalyticsFolder> = {},
): AnalyticsFolder {
  return {
    path,
    name: '',
    description: '',
    reportType: null,
    audience: [],
    restricted: false,
    retentionMonths: null,
    hiddenFields: [],
    ...overrides,
  };
}

export function actor(
  overrides: {
    mail?: string;
    groupIds?: string[];
    attributes?: string[];
    isGlobalAdmin?: boolean;
    isAnalyticsAdmin?: boolean;
  } = {},
): AnalyticsActor {
  const mail = overrides.mail ?? 'user@ocba.example.org';
  return {
    principal: {
      userId: `oid-${mail}`,
      mail,
      domain: mail.split('@')[1],
      attributes: overrides.attributes ?? [],
      groupIds: overrides.groupIds ?? [],
    },
    isGlobalAdmin: overrides.isGlobalAdmin ?? false,
    isAnalyticsAdmin:
      overrides.isAnalyticsAdmin ?? overrides.isGlobalAdmin ?? false,
  };
}

export function blob(
  path: string,
  overrides: Partial<DeliveredBlob> = {},
): DeliveredBlob {
  return {
    path,
    size: 1000,
    lastModified: '2026-08-03T08:00:00.000Z',
    ...overrides,
  };
}

export function state(
  forBlob: DeliveredBlob,
  overrides: Partial<AnalyticsFileState> = {},
): AnalyticsFileState {
  return {
    path: forBlob.path,
    blobVersion: `${forBlob.size}:${forBlob.lastModified}`,
    validatorVersion: VALIDATOR_VERSION,
    validatedAt: '2026-08-03T08:05:00.000Z',
    firstSeenAt: '2026-08-03T08:05:00.000Z',
    status: 'ok',
    issues: [],
    columns: [],
    declaredFields: [],
    inspected: true,
    reportType: null,
    previewVersion: null,
    rollupVersion: null,
    ...overrides,
  };
}
