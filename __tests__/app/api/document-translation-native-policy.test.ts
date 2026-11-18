import { NextRequest } from 'next/server';

import { WORKFLOW_FEATURE_DISABLED_CODE } from '@/lib/services/workflows/policy/guard';

import {
  NATIVE_PDF_FEATURE,
  NATIVE_PDF_MAX_PAGES,
} from '@/lib/utils/shared/translation/nativePdf';

import { parseJsonResponse } from './helpers';

import { POST as RENDER } from '@/app/api/document-translation/native/render/route';
import { GET, POST } from '@/app/api/document-translation/native/route';
import { POST as UNIT } from '@/app/api/document-translation/native/unit/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin policy (Admin > Workflows) is the only switch for the native PDF
 * routes: no environment variable is involved.
 */
const mockAuth = vi.hoisted(() => vi.fn());
const featureEnabled = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/workflows/policy/WorkflowPolicyService', () => ({
  WorkflowPolicyService: {
    getInstance: () => ({
      ensureFresh: vi.fn().mockResolvedValue(undefined),
      isFeatureEnabled: featureEnabled,
    }),
  },
}));
vi.mock('@/lib/services/documentTranslation/native/nativePdfPipeline', () => ({
  runNativePdfTranslation: vi.fn(),
  rerenderNativePdf: vi.fn(),
  reviseNativeUnit: vi.fn(),
}));
vi.mock('@/lib/services/documentTranslation/native/nativePdfStorage', () => ({
  storeNativeFile: vi.fn(),
  storeNativeRebuild: vi.fn(),
  readNativeFile: vi.fn(),
  isNativeFileId: vi.fn(() => false),
}));
vi.mock('@/lib/services/documentTranslation/native/nativePdfGlossary', () => ({
  resolveRequestGlossary: vi.fn(),
}));
vi.mock('@/lib/services/workflows/shared/workflowModels', () => ({
  resolveWorkflowModelId: vi.fn(),
}));
vi.mock('@/lib/services/workflows/shared/workflowUsage', () => ({
  beginWorkflowRun: vi.fn(),
}));

const post = (path: string) =>
  new NextRequest(`http://localhost/api/document-translation/native${path}`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });

describe('native PDF routes follow the admin policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
  });

  it('GET reports the feature as the policy has it, in both directions', async () => {
    featureEnabled.mockReturnValue(true);
    const on = await parseJsonResponse(await GET());
    expect(on.data.enabled).toBe(true);
    expect(on.data.maxPages).toBe(NATIVE_PDF_MAX_PAGES);
    expect(featureEnabled).toHaveBeenCalledWith(NATIVE_PDF_FEATURE);

    featureEnabled.mockReturnValue(false);
    const off = await parseJsonResponse(await GET());
    expect(off.data.enabled).toBe(false);
  });

  it('every POST route refuses with a stable code while the feature is off', async () => {
    featureEnabled.mockReturnValue(false);
    for (const response of [
      await POST(post('')),
      await RENDER(post('/render')),
      await UNIT(post('/unit')),
    ]) {
      expect(response.status).toBe(403);
      const body = await parseJsonResponse(response);
      expect(body.code).toBe(WORKFLOW_FEATURE_DISABLED_CODE);
    }
  });

  it('POST routes get past the gate while the feature is on', async () => {
    featureEnabled.mockReturnValue(true);
    for (const response of [
      await POST(post('')),
      await RENDER(post('/render')),
      await UNIT(post('/unit')),
    ]) {
      // An empty body fails validation, which only runs after the gate.
      expect(response.status).toBe(400);
    }
  });

  it('401s before consulting the policy when signed out', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(post(''))).status).toBe(401);
    expect(featureEnabled).not.toHaveBeenCalled();
  });
});
