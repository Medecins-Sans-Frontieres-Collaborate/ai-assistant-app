import { NextRequest } from 'next/server';

import { AzureBlobStorage } from '@/lib/utils/server/blob';

import { parseJsonResponse } from './helpers';

import { DELETE, GET, PATCH, POST } from '@/app/api/transcription/queue/route';
import { auth } from '@/auth';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mocks
const mockEnv = vi.hoisted(() => ({
  AZURE_BLOB_STORAGE_NAME: 'test-storage',
  AZURE_BLOB_STORAGE_KEY: 'test-key',
  AZURE_BLOB_STORAGE_CONTAINER: 'messages',
}));

// Mock dependencies
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/utils/server/blob', () => ({
  AzureBlobStorage: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(),
}));

vi.mock('@/config/environment', () => ({
  env: mockEnv,
}));

describe('/api/transcription/queue', () => {
  const mockSession = {
    user: {
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockQueueClient = {
    peekMessages: vi.fn(),
    receiveMessages: vi.fn(),
    exists: vi.fn(),
  };

  const mockAzureBlobStorage = {
    getQueueClient: vi.fn(),
    createQueue: vi.fn(),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup environment variables
    process.env.AZURE_BLOB_STORAGE_NAME = 'test-storage';
    process.env.AZURE_BLOB_STORAGE_KEY = 'test-key';
    process.env.AZURE_BLOB_STORAGE_CONTAINER = 'messages';

    vi.mocked(auth).mockResolvedValue(mockSession as any);
    // Mock as constructor function (not arrow function)
    vi.mocked(AzureBlobStorage).mockImplementation(function (this: any) {
      return mockAzureBlobStorage as any;
    } as any);
    mockAzureBlobStorage.getQueueClient.mockReturnValue(mockQueueClient as any);
    mockQueueClient.exists.mockResolvedValue(true);
    vi.mocked(uuidv4).mockReturnValue('test-uuid-123' as any);
  });

  describe('GET - Check Queue Position', () => {
    const createGetRequest = (
      messageId?: string,
      category?: string,
    ): NextRequest => {
      const params = new URLSearchParams();
      if (messageId) params.set('messageId', messageId);
      if (category) params.set('category', category);

      return new NextRequest(
        `http://localhost:3000/api/transcription/queue?${params.toString()}`,
      );
    };

    it('requires messageId parameter', async () => {
      const request = createGetRequest(undefined, 'transcription');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing messageId or category');
    });

    it('requires category parameter', async () => {
      const request = createGetRequest('msg-123', undefined);
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing messageId or category');
    });

    it('validates queue category against whitelist', async () => {
      const request = createGetRequest('msg-123', 'invalid-category');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid queue category');
      expect(data.allowedCategories).toEqual(['transcription', 'general']);
    });

    it('allows transcription category', async () => {
      mockQueueClient.peekMessages.mockResolvedValue({
        peekedMessageItems: [],
      });

      const request = createGetRequest('msg-123', 'transcription');
      const response = await GET(request);

      expect(response.status).not.toBe(400);
    });

    it('allows general category', async () => {
      mockQueueClient.peekMessages.mockResolvedValue({
        peekedMessageItems: [],
      });

      const request = createGetRequest('msg-123', 'general');
      const response = await GET(request);

      expect(response.status).not.toBe(400);
    });

    it('is case insensitive for category validation', async () => {
      mockQueueClient.peekMessages.mockResolvedValue({
        peekedMessageItems: [],
      });

      const request = createGetRequest('msg-123', 'TRANSCRIPTION');
      const response = await GET(request);

      expect(response.status).not.toBe(400);
    });

    it('returns message position when found', async () => {
      const encodedMessage = Buffer.from(
        JSON.stringify({
          messageId: 'msg-123',
          userId: 'test-user-id',
          message: 'Test message content',
        }),
      ).toString('base64');

      mockQueueClient.peekMessages.mockResolvedValue({
        peekedMessageItems: [{ messageText: encodedMessage }],
      });

      const request = createGetRequest('msg-123', 'transcription');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.position).toBe(1); // First position
      expect(data.message).toBe('Test message content');
    });

    it('returns correct position for message in middle of queue', async () => {
      const createMessage = (id: string, content: string) =>
        Buffer.from(
          JSON.stringify({
            messageId: id,
            userId: 'test-user-id',
            message: content,
          }),
        ).toString('base64');

      mockQueueClient.peekMessages.mockResolvedValue({
        peekedMessageItems: [
          { messageText: createMessage('msg-1', 'Message 1') },
          { messageText: createMessage('msg-2', 'Message 2') },
          { messageText: createMessage('msg-3', 'Message 3') },
        ],
      });

      const request = createGetRequest('msg-2', 'transcription');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(data.position).toBe(2);
      expect(data.message).toBe('Message 2');
    });

    it('returns 404 when message not found', async () => {
      mockQueueClient.peekMessages.mockResolvedValue({
        peekedMessageItems: [],
      });

      const request = createGetRequest('nonexistent', 'transcription');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(404);
      expect(data.error).toContain('Message not found in queue');
    });

    it('returns 403 when message belongs to different user', async () => {
      const encodedMessage = Buffer.from(
        JSON.stringify({
          messageId: 'msg-123',
          userId: 'other-user-id',
          message: 'Test message',
        }),
      ).toString('base64');

      mockQueueClient.peekMessages.mockResolvedValue({
        peekedMessageItems: [{ messageText: encodedMessage }],
      });

      const request = createGetRequest('msg-123', 'transcription');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(403);
      expect(data.message).toContain('Forbidden');
    });

    it('handles pagination for large queues', async () => {
      const createMessage = (id: string) =>
        Buffer.from(
          JSON.stringify({
            messageId: id,
            userId: 'test-user-id',
            message: `Message ${id}`,
          }),
        ).toString('base64');

      // First page: 32 messages
      const firstPage = Array.from({ length: 32 }, (_, i) => ({
        messageText: createMessage(`msg-${i}`),
      }));

      // Second page: target message
      const secondPage = [
        {
          messageText: createMessage('target-msg'),
        },
      ];

      mockQueueClient.peekMessages
        .mockResolvedValueOnce({ peekedMessageItems: firstPage })
        .mockResolvedValueOnce({ peekedMessageItems: secondPage });

      const request = createGetRequest('target-msg', 'transcription');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(data.position).toBe(33); // 32 + 1
    });

    it('returns 500 when not authenticated', async () => {
      (vi.mocked(auth) as any).mockResolvedValue(null);

      const request = createGetRequest('msg-123', 'transcription');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal Server Error');
    });

    it('returns 401 for unauthorized errors', async () => {
      vi.mocked(auth).mockRejectedValue(new Error('Unauthorized'));

      const request = createGetRequest('msg-123', 'transcription');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('returns 500 for other errors', async () => {
      mockQueueClient.peekMessages.mockRejectedValue(new Error('Queue error'));

      const request = createGetRequest('msg-123', 'transcription');
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal Server Error');
    });
  });

  describe('POST - Add Message to Queue', () => {
    const createPostRequest = (body: any): NextRequest => {
      return new NextRequest('http://localhost:3000/api/transcription/queue', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
    };

    it('requires message field', async () => {
      const request = createPostRequest({ category: 'transcription' });
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing message or category');
    });

    it('requires category field', async () => {
      const request = createPostRequest({ message: 'Test message' });
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing message or category');
    });

    it('validates queue category against whitelist', async () => {
      const request = createPostRequest({
        message: 'Test',
        category: 'invalid',
      });
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid queue category');
    });

    it('creates queue if it does not exist', async () => {
      mockQueueClient.exists.mockResolvedValue(false);
      mockAzureBlobStorage.addMessage.mockResolvedValue({
        messageId: 'azure-msg-id',
        insertedOn: new Date(),
        expiresOn: new Date(),
      });

      const request = createPostRequest({
        message: 'Test',
        category: 'transcription',
      });
      await POST(request);

      expect(mockAzureBlobStorage.createQueue).toHaveBeenCalledWith(
        'transcription',
      );
    });

    it('does not create queue if it exists', async () => {
      mockQueueClient.exists.mockResolvedValue(true);
      mockAzureBlobStorage.addMessage.mockResolvedValue({
        messageId: 'azure-msg-id',
        insertedOn: new Date(),
        expiresOn: new Date(),
      });

      const request = createPostRequest({
        message: 'Test',
        category: 'transcription',
      });
      await POST(request);

      expect(mockAzureBlobStorage.createQueue).not.toHaveBeenCalled();
    });

    it('generates UUID for message', async () => {
      vi.mocked(uuidv4).mockReturnValue('generated-uuid' as any);
      mockAzureBlobStorage.addMessage.mockResolvedValue({
        messageId: 'azure-msg-id',
        insertedOn: new Date(),
        expiresOn: new Date(),
      });

      const request = createPostRequest({
        message: 'Test',
        category: 'transcription',
      });
      await POST(request);

      expect(uuidv4).toHaveBeenCalled();
    });

    it('includes userId and messageId in message', async () => {
      mockAzureBlobStorage.addMessage.mockResolvedValue({
        messageId: 'azure-msg-id',
        insertedOn: new Date(),
        expiresOn: new Date(),
      });

      const request = createPostRequest({
        message: 'Test content',
        category: 'transcription',
      });
      await POST(request);

      const addMessageCall = mockAzureBlobStorage.addMessage.mock.calls[0];
      const encodedMessage = addMessageCall[1];
      const decodedMessage = JSON.parse(
        Buffer.from(encodedMessage, 'base64').toString('utf-8'),
      );

      expect(decodedMessage.messageId).toBe('test-uuid-123');
      expect(decodedMessage.userId).toBe('test-user-id');
      expect(decodedMessage.message).toBe('Test content');
    });

    it('base64 encodes message before adding to queue', async () => {
      mockAzureBlobStorage.addMessage.mockResolvedValue({
        messageId: 'azure-msg-id',
        insertedOn: new Date(),
        expiresOn: new Date(),
      });

      const request = createPostRequest({
        message: 'Test',
        category: 'transcription',
      });
      await POST(request);

      const encodedMessage = mockAzureBlobStorage.addMessage.mock.calls[0][1];
      // Should be valid base64
      expect(() => Buffer.from(encodedMessage, 'base64')).not.toThrow();
    });

    it('returns 201 with message metadata on success', async () => {
      const insertedOn = new Date('2025-01-01T00:00:00Z');
      const expiresOn = new Date('2025-01-08T00:00:00Z');

      mockAzureBlobStorage.addMessage.mockResolvedValue({
        messageId: 'azure-msg-id',
        insertedOn,
        expiresOn,
      });

      const request = createPostRequest({
        message: 'Test',
        category: 'transcription',
      });
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(201);
      expect(data.messageId).toBe('azure-msg-id');
      expect(data.insertedOn).toBe(insertedOn.toISOString());
      expect(data.expiresOn).toBe(expiresOn.toISOString());
    });

    it('handles complex message objects', async () => {
      mockAzureBlobStorage.addMessage.mockResolvedValue({
        messageId: 'azure-msg-id',
        insertedOn: new Date(),
        expiresOn: new Date(),
      });

      const complexMessage = {
        type: 'transcription',
        data: { file: 'audio.mp3', duration: 120 },
        metadata: { priority: 'high' },
      };

      const request = createPostRequest({
        message: complexMessage,
        category: 'transcription',
      });
      await POST(request);

      const encodedMessage = mockAzureBlobStorage.addMessage.mock.calls[0][1];
      const decodedMessage = JSON.parse(
        Buffer.from(encodedMessage, 'base64').toString('utf-8'),
      );

      expect(decodedMessage.message).toEqual(complexMessage);
    });

    it('returns 500 when not authenticated', async () => {
      (vi.mocked(auth) as any).mockResolvedValue(null);

      const request = createPostRequest({
        message: 'Test',
        category: 'transcription',
      });
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal Server Error');
    });

    it('returns 500 for queue operation errors', async () => {
      mockAzureBlobStorage.addMessage.mockRejectedValue(
        new Error('Queue error'),
      );

      const request = createPostRequest({
        message: 'Test',
        category: 'transcription',
      });
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal Server Error');
    });
  });

  describe('PATCH - Update Message', () => {
    const createPatchRequest = (body: any): NextRequest => {
      return new NextRequest('http://localhost:3000/api/transcription/queue', {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
    };

    it('requires messageId field', async () => {
      const request = createPatchRequest({
        category: 'transcription',
        message: 'Updated',
      });
      const response = await PATCH(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing messageId, category, or message');
    });

    it('requires category field', async () => {
      const request = createPatchRequest({
        messageId: 'msg-123',
        message: 'Updated',
      });
      const response = await PATCH(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing messageId, category, or message');
    });

    it('requires message field', async () => {
      const request = createPatchRequest({
        messageId: 'msg-123',
        category: 'transcription',
      });
      const response = await PATCH(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing messageId, category, or message');
    });

    it('validates queue category against whitelist', async () => {
      const request = createPatchRequest({
        messageId: 'msg-123',
        category: 'invalid',
        message: 'Updated',
      });
      const response = await PATCH(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid queue category');
    });

    it('updates message successfully', async () => {
      const originalMessage = Buffer.from(
        JSON.stringify({
          messageId: 'msg-123',
          userId: 'test-user-id',
          message: 'Original',
        }),
      ).toString('base64');

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: 'azure-msg-id',
            popReceipt: 'pop-receipt',
            messageText: originalMessage,
          },
        ],
      });

      const request = createPatchRequest({
        messageId: 'msg-123',
        category: 'transcription',
        message: 'Updated content',
      });
      const response = await PATCH(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.message).toBe('Message updated successfully');
      expect(mockAzureBlobStorage.updateMessage).toHaveBeenCalled();
    });

    it('preserves messageId and userId when updating', async () => {
      const originalMessage = Buffer.from(
        JSON.stringify({
          messageId: 'msg-123',
          userId: 'test-user-id',
          message: 'Original',
        }),
      ).toString('base64');

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: 'azure-msg-id',
            popReceipt: 'pop-receipt',
            messageText: originalMessage,
          },
        ],
      });

      const request = createPatchRequest({
        messageId: 'msg-123',
        category: 'transcription',
        message: 'Updated',
      });
      await PATCH(request);

      const updateCall = mockAzureBlobStorage.updateMessage.mock.calls[0];
      const encodedMessage = updateCall[3];
      const decodedMessage = JSON.parse(
        Buffer.from(encodedMessage, 'base64').toString('utf-8'),
      );

      expect(decodedMessage.messageId).toBe('msg-123');
      expect(decodedMessage.userId).toBe('test-user-id');
      expect(decodedMessage.message).toBe('Updated');
    });

    it('returns 404 when message not found', async () => {
      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [],
      });

      const request = createPatchRequest({
        messageId: 'nonexistent',
        category: 'transcription',
        message: 'Updated',
      });
      const response = await PATCH(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(404);
      expect(data.error).toContain('Message not found in queue');
    });

    it('returns 403 when message belongs to different user', async () => {
      const message = Buffer.from(
        JSON.stringify({
          messageId: 'msg-123',
          userId: 'other-user-id',
          message: 'Original',
        }),
      ).toString('base64');

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: 'azure-msg-id',
            popReceipt: 'pop-receipt',
            messageText: message,
          },
        ],
      });

      const request = createPatchRequest({
        messageId: 'msg-123',
        category: 'transcription',
        message: 'Updated',
      });
      const response = await PATCH(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(403);
      expect(data.error).toBe('Forbidden');
    });

    it('returns 500 when not authenticated', async () => {
      (vi.mocked(auth) as any).mockResolvedValue(null);

      const request = createPatchRequest({
        messageId: 'msg-123',
        category: 'transcription',
        message: 'Updated',
      });
      const response = await PATCH(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal Server Error');
    });
  });

  describe('DELETE - Remove Message', () => {
    const createDeleteRequest = (
      messageId?: string,
      category?: string,
    ): NextRequest => {
      const params = new URLSearchParams();
      if (messageId) params.set('messageId', messageId);
      if (category) params.set('category', category);

      return new NextRequest(
        `http://localhost:3000/api/transcription/queue?${params.toString()}`,
        { method: 'DELETE' },
      );
    };

    it('requires messageId parameter', async () => {
      const request = createDeleteRequest(undefined, 'transcription');
      const response = await DELETE(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing messageId or category');
    });

    it('requires category parameter', async () => {
      const request = createDeleteRequest('msg-123', undefined);
      const response = await DELETE(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing messageId or category');
    });

    it('validates queue category against whitelist', async () => {
      const request = createDeleteRequest('msg-123', 'invalid');
      const response = await DELETE(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid queue category');
    });

    it('deletes message successfully', async () => {
      const message = Buffer.from(
        JSON.stringify({
          messageId: 'msg-123',
          userId: 'test-user-id',
          message: 'Content',
        }),
      ).toString('base64');

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: 'azure-msg-id',
            popReceipt: 'pop-receipt',
            messageText: message,
          },
        ],
      });

      const request = createDeleteRequest('msg-123', 'transcription');
      const response = await DELETE(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.message).toBe('Message deleted successfully');
      expect(mockAzureBlobStorage.deleteMessage).toHaveBeenCalledWith(
        'transcription',
        'azure-msg-id',
        'pop-receipt',
      );
    });

    it('returns 404 when message not found', async () => {
      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [],
      });

      const request = createDeleteRequest('nonexistent', 'transcription');
      const response = await DELETE(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(404);
      expect(data.error).toContain('Message not found in queue');
    });

    it('returns 403 when message belongs to different user', async () => {
      const message = Buffer.from(
        JSON.stringify({
          messageId: 'msg-123',
          userId: 'other-user-id',
          message: 'Content',
        }),
      ).toString('base64');

      mockQueueClient.receiveMessages.mockResolvedValue({
        receivedMessageItems: [
          {
            messageId: 'azure-msg-id',
            popReceipt: 'pop-receipt',
            messageText: message,
          },
        ],
      });

      const request = createDeleteRequest('msg-123', 'transcription');
      const response = await DELETE(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(403);
      expect(data.error).toBe('Forbidden');
    });

    it('returns 500 when not authenticated', async () => {
      (vi.mocked(auth) as any).mockResolvedValue(null);

      const request = createDeleteRequest('msg-123', 'transcription');
      const response = await DELETE(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal Server Error');
    });

    it('returns 500 for queue operation errors', async () => {
      mockQueueClient.receiveMessages.mockRejectedValue(
        new Error('Queue error'),
      );

      const request = createDeleteRequest('msg-123', 'transcription');
      const response = await DELETE(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal Server Error');
    });
  });

  describe('Environment Configuration', () => {
    it('throws error when storage account name is missing', async () => {
      delete process.env.AZURE_BLOB_STORAGE_NAME;

      const request = new NextRequest(
        'http://localhost:3000/api/transcription/queue',
        {
          method: 'POST',
          body: JSON.stringify({ message: 'Test', category: 'transcription' }),
        },
      );

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal Server Error');
    });

    it('uses default container name when not specified', async () => {
      delete process.env.AZURE_BLOB_STORAGE_CONTAINER;
      mockAzureBlobStorage.addMessage.mockResolvedValue({
        messageId: 'azure-msg-id',
        insertedOn: new Date(),
        expiresOn: new Date(),
      });

      const request = new NextRequest(
        'http://localhost:3000/api/transcription/queue',
        {
          method: 'POST',
          body: JSON.stringify({ message: 'Test', category: 'transcription' }),
        },
      );

      await POST(request);

      // AzureBlobStorage should be initialized with 'messages' as default container
      expect(AzureBlobStorage).toHaveBeenCalledWith(
        'test-storage',
        'test-key',
        'messages',
        mockSession.user,
      );
    });
  });
});
