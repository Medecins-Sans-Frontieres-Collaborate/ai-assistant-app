import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { getBlobBase64String } from '@/lib/utils/server/blob';

import { parseJsonResponse } from './helpers';

import { GET } from '@/app/api/file/[id]/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));

vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: vi.fn(),
}));

vi.mock('@/lib/utils/server/blob', () => ({
  BlobProperty: {
    BLOB: 'blob',
  },
  getBlobBase64String: vi.fn(),
}));

describe('/api/file/[id]', () => {
  const mockSession = {
    user: {
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const validSha256 = 'a'.repeat(64); // Valid 64-char SHA256 hash
  const mockBlobClient = {
    get: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(auth).mockResolvedValue(mockSession as any);
    vi.mocked(getUserIdFromSession).mockReturnValue('test-user-id');
    vi.mocked(createBlobStorageClient).mockReturnValue(mockBlobClient as any);
    vi.mocked(getBlobBase64String).mockResolvedValue(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    mockBlobClient.get.mockResolvedValue(Buffer.from('file content'));
  });

  const createRequest = (id: string, filetype?: string): NextRequest => {
    const params = new URLSearchParams();
    if (filetype) params.set('filetype', filetype);

    const url = `http://localhost:3000/api/file/${id}${params.toString() ? `?${params.toString()}` : ''}`;
    return new NextRequest(url);
  };

  describe('ID Validation', () => {
    it('accepts valid SHA256 hash without extension', async () => {
      const request = createRequest(validSha256);
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });

      expect(response.status).toBe(200);
    });

    it('accepts valid SHA256 hash with extension', async () => {
      const idWithExtension = `${validSha256}.pdf`;
      const request = createRequest(idWithExtension, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: idWithExtension }),
      });

      expect(response.status).toBe(200);
    });

    it('accepts extension up to 4 characters', async () => {
      const idWithExtension = `${validSha256}.jpeg`;
      const request = createRequest(idWithExtension, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: idWithExtension }),
      });

      expect(response.status).toBe(200);
    });

    it('rejects hash that is too short', async () => {
      const shortHash = 'a'.repeat(63); // 63 chars instead of 64
      const request = createRequest(shortHash);
      const response = await GET(request, {
        params: Promise.resolve({ id: shortHash }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid file identifier');
    });

    it('rejects hash that is too long', async () => {
      const longHash = 'a'.repeat(65); // 65 chars instead of 64
      const request = createRequest(longHash);
      const response = await GET(request, {
        params: Promise.resolve({ id: longHash }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid file identifier');
    });

    it('rejects hash with invalid characters', async () => {
      const invalidHash = 'z'.repeat(64); // 'z' is not valid hex
      const request = createRequest(invalidHash);
      const response = await GET(request, {
        params: Promise.resolve({ id: invalidHash }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid file identifier');
    });

    it('rejects hash with uppercase characters', async () => {
      const invalidHash = 'A'.repeat(64); // Uppercase not allowed
      const request = createRequest(invalidHash);
      const response = await GET(request, {
        params: Promise.resolve({ id: invalidHash }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid file identifier');
    });

    it('rejects extension longer than 4 characters', async () => {
      const idWithLongExtension = `${validSha256}.jsonld`;
      const request = createRequest(idWithLongExtension);
      const response = await GET(request, {
        params: Promise.resolve({ id: idWithLongExtension }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid file identifier');
    });

    it('rejects ID with multiple dots', async () => {
      const idWithMultipleDots = `${validSha256}.tar.gz`;
      const request = createRequest(idWithMultipleDots);
      const response = await GET(request, {
        params: Promise.resolve({ id: idWithMultipleDots }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid file identifier');
    });

    it('rejects empty string', async () => {
      const request = createRequest('');
      const response = await GET(request, {
        params: Promise.resolve({ id: '' }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid file identifier');
    });
  });

  describe('Authentication', () => {
    it('requires authentication', async () => {
      (vi.mocked(auth) as any).mockResolvedValue(null);

      const request = createRequest(validSha256);
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('uses authenticated user ID for file path', async () => {
      vi.mocked(getUserIdFromSession).mockReturnValue('custom-user-123');

      const request = createRequest(validSha256, 'file');
      await GET(request, { params: Promise.resolve({ id: validSha256 }) });

      expect(mockBlobClient.get).toHaveBeenCalledWith(
        `custom-user-123/uploads/files/${validSha256}`,
        'blob',
      );
    });
  });

  describe('File Type Handling', () => {
    it('defaults to file type when no filetype specified', async () => {
      const request = createRequest(validSha256);
      await GET(request, { params: Promise.resolve({ id: validSha256 }) });

      expect(mockBlobClient.get).toHaveBeenCalledWith(
        `test-user-id/uploads/files/${validSha256}`,
        'blob',
      );
    });

    it('uses file type when explicitly specified', async () => {
      const request = createRequest(validSha256, 'file');
      await GET(request, { params: Promise.resolve({ id: validSha256 }) });

      expect(mockBlobClient.get).toHaveBeenCalledWith(
        `test-user-id/uploads/files/${validSha256}`,
        'blob',
      );
    });

    it('uses image type when specified', async () => {
      const request = createRequest(validSha256, 'image');
      await GET(request, { params: Promise.resolve({ id: validSha256 }) });

      expect(getBlobBase64String).toHaveBeenCalledWith(
        'test-user-id',
        validSha256,
        undefined,
        mockSession.user,
      );
    });

    it('ignores invalid filetype values', async () => {
      const request = createRequest(validSha256, 'invalid-type');
      await GET(request, { params: Promise.resolve({ id: validSha256 }) });

      // Should default to 'file'
      expect(mockBlobClient.get).toHaveBeenCalledWith(
        `test-user-id/uploads/files/${validSha256}`,
        'blob',
      );
    });

    it('constructs correct path for files', async () => {
      const request = createRequest(validSha256, 'file');
      await GET(request, { params: Promise.resolve({ id: validSha256 }) });

      expect(mockBlobClient.get).toHaveBeenCalledWith(
        'test-user-id/uploads/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'blob',
      );
    });

    it('constructs correct path for images', async () => {
      const request = createRequest(validSha256, 'image');
      await GET(request, { params: Promise.resolve({ id: validSha256 }) });

      expect(getBlobBase64String).toHaveBeenCalledWith(
        'test-user-id',
        validSha256,
        undefined,
        mockSession.user,
      );
    });
  });

  describe('Image Retrieval', () => {
    it('returns base64 URL for images', async () => {
      vi.mocked(getBlobBase64String).mockResolvedValue(
        'data:image/png;base64,abc123',
      );

      const request = createRequest(validSha256, 'image');
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.base64Url).toBe('data:image/png;base64,abc123');
    });

    it('handles different image formats', async () => {
      const jpegId = `${validSha256}.jpg`;
      vi.mocked(getBlobBase64String).mockResolvedValue(
        'data:image/jpeg;base64,xyz789',
      );

      const request = createRequest(jpegId, 'image');
      const response = await GET(request, {
        params: Promise.resolve({ id: jpegId }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.base64Url).toBe('data:image/jpeg;base64,xyz789');
    });
  });

  describe('File Retrieval', () => {
    it('returns buffer for files', async () => {
      const fileContent = Buffer.from('test file content');
      mockBlobClient.get.mockResolvedValue(fileContent);

      const request = createRequest(validSha256, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });

      expect(response.status).toBe(200);

      // Response should be a buffer
      const buffer = Buffer.from(await response.arrayBuffer());
      expect(buffer.toString()).toBe('test file content');
    });

    it('handles binary file content', async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      mockBlobClient.get.mockResolvedValue(binaryContent);

      const request = createRequest(validSha256, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });

      expect(response.status).toBe(200);

      const buffer = Buffer.from(await response.arrayBuffer());
      expect(buffer).toEqual(binaryContent);
    });

    it('handles large files', async () => {
      const largeContent = Buffer.from('x'.repeat(1024 * 1024)); // 1MB
      mockBlobClient.get.mockResolvedValue(largeContent);

      const request = createRequest(validSha256, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });

      expect(response.status).toBe(200);

      const buffer = Buffer.from(await response.arrayBuffer());
      expect(buffer.length).toBe(1024 * 1024);
    });
  });

  describe('Error Handling', () => {
    it('handles blob storage errors', async () => {
      mockBlobClient.get.mockRejectedValue(new Error('Storage error'));

      const request = createRequest(validSha256, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to retrieve file');
    });

    it('handles image retrieval errors', async () => {
      vi.mocked(getBlobBase64String).mockRejectedValue(
        new Error('Image error'),
      );

      const request = createRequest(validSha256, 'image');
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to retrieve file');
    });

    it('logs errors to console', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      mockBlobClient.get.mockRejectedValue(new Error('Test error'));

      const request = createRequest(validSha256, 'file');
      await GET(request, { params: Promise.resolve({ id: validSha256 }) });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error retrieving blob:',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });

    it('includes cache headers in error response', async () => {
      mockBlobClient.get.mockRejectedValue(new Error('Storage error'));

      const request = createRequest(validSha256, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });

      expect(response.headers.get('Cache-Control')).toBe(
        's-maxage=43200, stale-while-revalidate',
      );
    });

    it('handles file not found errors', async () => {
      mockBlobClient.get.mockRejectedValue(new Error('File not found'));

      const request = createRequest(validSha256, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to retrieve file');
    });
  });

  describe('Edge Cases', () => {
    it('handles ID with extension for files', async () => {
      const idWithExtension = `${validSha256}.pdf`;
      mockBlobClient.get.mockResolvedValue(Buffer.from('PDF content'));

      const request = createRequest(idWithExtension, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: idWithExtension }),
      });

      expect(response.status).toBe(200);
      expect(mockBlobClient.get).toHaveBeenCalledWith(
        `test-user-id/uploads/files/${idWithExtension}`,
        'blob',
      );
    });

    it('handles ID with extension for images', async () => {
      const idWithExtension = `${validSha256}.png`;
      vi.mocked(getBlobBase64String).mockResolvedValue(
        'data:image/png;base64,abc',
      );

      const request = createRequest(idWithExtension, 'image');
      const response = await GET(request, {
        params: Promise.resolve({ id: idWithExtension }),
      });
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.base64Url).toBe('data:image/png;base64,abc');
    });

    it('handles empty buffer response', async () => {
      mockBlobClient.get.mockResolvedValue(Buffer.from(''));

      const request = createRequest(validSha256, 'file');
      const response = await GET(request, {
        params: Promise.resolve({ id: validSha256 }),
      });

      expect(response.status).toBe(200);

      const buffer = Buffer.from(await response.arrayBuffer());
      expect(buffer.length).toBe(0);
    });

    it('validates ID before checking authentication', async () => {
      (vi.mocked(auth) as any).mockResolvedValue(null);

      const request = createRequest('invalid-id');
      const response = await GET(request, {
        params: Promise.resolve({ id: 'invalid-id' }),
      });

      // Should return 400 for invalid ID before checking auth
      expect(response.status).toBe(400);
    });
  });
});
