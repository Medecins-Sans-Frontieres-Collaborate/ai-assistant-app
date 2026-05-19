import { NextRequest } from 'next/server';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { DELETE } from '@/app/api/chat/agents/threads/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockDefaultAzureCredential = vi.hoisted(() => vi.fn());
const mockAgentsClient = vi.hoisted(() => vi.fn());
const mockThreadsDelete = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AZURE_AI_FOUNDRY_ENDPOINT: 'https://test-foundry.services.ai.azure.com',
}));

vi.mock('@/auth', () => ({
  auth: mockAuth,
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: mockDefaultAzureCredential,
}));

vi.mock('@azure/ai-agents', () => ({
  AgentsClient: mockAgentsClient,
}));

vi.mock('@/config/environment', () => ({
  env: mockEnv,
}));

const createDeleteRequest = (body: any): NextRequest =>
  createMockRequest({
    method: 'DELETE',
    url: 'http://localhost:3000/api/chat/agents/threads',
    body,
  });

describe('/api/chat/agents/threads', () => {
  const validId = 'thread_abc123';
  const validId2 = 'thread_def456';

  beforeEach(() => {
    vi.clearAllMocks();

    mockAuth.mockResolvedValue(createMockSession() as any);
    mockDefaultAzureCredential.mockImplementation(function (this: any) {
      return {};
    });
    mockThreadsDelete.mockResolvedValue({
      id: validId,
      deleted: true,
      object: 'thread.deleted',
    });
    mockAgentsClient.mockImplementation(function (this: any) {
      return {
        threads: { delete: mockThreadsDelete },
      };
    });
    mockEnv.AZURE_AI_FOUNDRY_ENDPOINT =
      'https://test-foundry.services.ai.azure.com';
  });

  describe('Authentication', () => {
    it('returns 401 without a session', async () => {
      mockAuth.mockResolvedValue(null);
      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId] }),
      );
      expect(response.status).toBe(401);
    });

    it('returns 401 when session has no user', async () => {
      mockAuth.mockResolvedValue({ user: null } as any);
      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId] }),
      );
      expect(response.status).toBe(401);
    });
  });

  describe('Request validation', () => {
    it('returns 400 when threadIds is missing', async () => {
      const response = await DELETE(createDeleteRequest({}));
      const data = await parseJsonResponse(response);
      expect(response.status).toBe(400);
      expect(data.error).toContain('non-empty array');
    });

    it('returns 400 when threadIds is empty', async () => {
      const response = await DELETE(createDeleteRequest({ threadIds: [] }));
      expect(response.status).toBe(400);
    });

    it('returns 400 when threadIds is not an array', async () => {
      const response = await DELETE(
        createDeleteRequest({ threadIds: 'thread_abc123' }),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid threadId format', async () => {
      const response = await DELETE(
        createDeleteRequest({ threadIds: ['notathread', validId] }),
      );
      const data = await parseJsonResponse(response);
      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid threadId format');
    });

    it('returns 400 when batch exceeds 500 ids', async () => {
      const big = Array.from({ length: 501 }, (_, i) => `thread_${i}`);
      const response = await DELETE(createDeleteRequest({ threadIds: big }));
      expect(response.status).toBe(400);
    });

    it('rejects mixed-type arrays', async () => {
      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId, 12345] }),
      );
      expect(response.status).toBe(400);
    });
  });

  describe('Happy path', () => {
    it('deletes all thread ids and reports counts', async () => {
      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId, validId2] }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.deleted).toBe(2);
      expect(data.notFound).toBe(0);
      expect(data.failed).toEqual([]);
      expect(mockThreadsDelete).toHaveBeenCalledWith(validId);
      expect(mockThreadsDelete).toHaveBeenCalledWith(validId2);
      expect(mockThreadsDelete).toHaveBeenCalledTimes(2);
    });

    it('de-duplicates repeated thread ids', async () => {
      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId, validId, validId] }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(mockThreadsDelete).toHaveBeenCalledTimes(1);
      expect(data.deleted).toBe(1);
    });
  });

  describe('Per-thread error handling', () => {
    it('counts Azure 404 as not_found (still overall 200)', async () => {
      const err = Object.assign(new Error('not found'), { statusCode: 404 });
      mockThreadsDelete.mockResolvedValueOnce({ deleted: true });
      mockThreadsDelete.mockRejectedValueOnce(err);

      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId, validId2] }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.deleted).toBe(1);
      expect(data.notFound).toBe(1);
      expect(data.failed).toEqual([]);
    });

    it('counts Azure code:NotFound as not_found', async () => {
      const err = Object.assign(new Error('not found'), { code: 'NotFound' });
      mockThreadsDelete.mockRejectedValueOnce(err);

      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId] }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.notFound).toBe(1);
    });

    it('records per-item errors in failed[] but still returns 200', async () => {
      mockThreadsDelete.mockResolvedValueOnce({ deleted: true });
      mockThreadsDelete.mockRejectedValueOnce(new Error('5xx upstream'));

      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId, validId2] }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.deleted).toBe(1);
      expect(data.failed).toHaveLength(1);
      expect(data.failed[0].threadId).toBe(validId2);
      expect(data.failed[0].error).toContain('5xx upstream');
    });

    it('treats deleted:false as a failure', async () => {
      mockThreadsDelete.mockResolvedValueOnce({ deleted: false });
      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId] }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.deleted).toBe(0);
      expect(data.failed).toHaveLength(1);
    });
  });

  describe('Environment configuration', () => {
    it('returns 500 when AZURE_AI_FOUNDRY_ENDPOINT is not configured', async () => {
      mockEnv.AZURE_AI_FOUNDRY_ENDPOINT = undefined as any;
      const response = await DELETE(
        createDeleteRequest({ threadIds: [validId] }),
      );
      expect(response.status).toBe(500);
    });
  });
});
