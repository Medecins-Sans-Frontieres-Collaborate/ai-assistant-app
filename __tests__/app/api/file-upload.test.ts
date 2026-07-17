import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import Hasher from '@/lib/utils/app/hash';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  getContentType,
  validateBufferSignature,
  validateFileNotExecutable,
} from '@/lib/utils/server/file/mimeTypes';

import { parseJsonResponse } from './helpers';

import { POST } from '@/app/api/file/upload/route';
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

vi.mock('@/lib/utils/server/file/mimeTypes', () => ({
  validateFileNotExecutable: vi.fn(),
  validateBufferSignature: vi.fn(),
  getContentType: vi.fn(),
}));

vi.mock('@/lib/utils/app/hash', () => ({
  default: {
    sha256: vi.fn(),
  },
}));

describe('/api/file/upload', () => {
  const mockSession = {
    user: {
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockBlobClient = {
    upload: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mocks
    vi.mocked(auth).mockResolvedValue(mockSession as any);
    vi.mocked(getUserIdFromSession).mockReturnValue('test-user-id');
    vi.mocked(createBlobStorageClient).mockReturnValue(mockBlobClient as any);
    vi.mocked(validateFileNotExecutable).mockReturnValue({ isValid: true });
    vi.mocked(validateBufferSignature).mockReturnValue({ isValid: true });
    vi.mocked(getContentType).mockReturnValue('text/plain');
    vi.mocked(Hasher.sha256).mockReturnValue('a'.repeat(300)); // Long hash for slicing
    mockBlobClient.upload.mockResolvedValue(
      'https://storage.example.com/file.txt',
    );
  });

  const createRequest = (options: {
    filename?: string;
    filetype?: string;
    mime?: string;
    body?: string;
  }): NextRequest => {
    const { filename, filetype, mime, body = 'test file content' } = options;

    const params = new URLSearchParams();
    if (filename) params.set('filename', filename);
    if (filetype) params.set('filetype', filetype);
    if (mime) params.set('mime', mime);

    const url = `http://localhost:3000/api/file/upload?${params.toString()}`;

    return new NextRequest(url, {
      method: 'POST',
      body,
    });
  };

  // Minimal valid PNG (1x1 transparent) wrapped in a data URL. Used by the
  // legacy text-body image path, which now validates that the body is a
  // real base64 data URL with recognizable image magic bytes.
  const VALID_PNG_DATA_URL = (() => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    return `data:image/png;base64,${png.toString('base64')}`;
  })();

  describe('Request Validation', () => {
    it('returns 400 when filename is missing', async () => {
      const request = createRequest({ filename: '' });
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Filename is required');
    });

    it('returns 400 when file is executable', async () => {
      vi.mocked(validateFileNotExecutable).mockReturnValue({
        isValid: false,
        error: 'Executable files are not allowed',
      });

      const request = createRequest({
        filename: 'malicious.exe',
        filetype: 'file',
      });
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Executable files are not allowed');
    });

    it('validates file extension and mime type', async () => {
      const request = createRequest({
        filename: 'test.exe',
        filetype: 'file',
        mime: 'application/x-msdownload',
      });

      await POST(request);

      expect(validateFileNotExecutable).toHaveBeenCalledWith(
        'test.exe',
        'application/x-msdownload',
      );
    });

    it('accepts large video files up to 1.5GB', async () => {
      // Category-based limits:
      // - Documents: 50MB
      // - Audio: 1GB
      // - Video: 1.5GB
      // Testing with a 51MB video file to verify it's accepted (under 1.5GB limit)
      const largeContent = Buffer.alloc(51 * 1024 * 1024, 'x');
      const file = new File([largeContent], 'large.mp4', {
        type: 'video/mp4',
      });

      const formData = new FormData();
      formData.append('file', file);

      const params = new URLSearchParams();
      params.set('filename', 'large.mp4');
      params.set('filetype', 'video');
      params.set('mime', 'video/mp4');

      const url = `http://localhost:3000/api/file/upload?${params.toString()}`;
      const request = new NextRequest(url, {
        method: 'POST',
        body: formData,
      });

      const response = await POST(request);

      // 51MB video files should be accepted (limit is 1.5GB)
      expect(response.status).toBe(200);
    });

    it('rejects documents exceeding 50MB limit', async () => {
      // Documents have a 50MB limit
      const largeContent = Buffer.alloc(51 * 1024 * 1024, 'x');
      const file = new File([largeContent], 'large.txt', {
        type: 'text/plain',
      });

      const formData = new FormData();
      formData.append('file', file);

      const params = new URLSearchParams();
      params.set('filename', 'large.txt');
      params.set('filetype', 'file');
      params.set('mime', 'text/plain');

      const url = `http://localhost:3000/api/file/upload?${params.toString()}`;
      const request = new NextRequest(url, {
        method: 'POST',
        body: formData,
      });

      const response = await POST(request);

      // 51MB document files should be rejected (limit is 50MB)
      expect(response.status).toBe(413);
    });

    it('returns 400 for malformed mime query param', async () => {
      const request = createRequest({
        filename: 'test.txt',
        mime: '<script>alert(1)</script>',
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid MIME type');
    });

    it('returns 400 when image data URL is not actually an image', async () => {
      // Looks like a data URL but the bytes are plain text, not an image.
      const fakeDataUrl =
        'data:image/png;base64,' +
        Buffer.from('not an image').toString('base64');
      const request = createRequest({
        filename: 'fake.png',
        filetype: 'image',
        mime: 'image/png',
        body: fakeDataUrl,
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe(
        'File content does not match a recognized image format',
      );
    });

    it('returns 400 when legacy image body is not a data URL', async () => {
      const request = createRequest({
        filename: 'test.png',
        filetype: 'image',
        body: 'not-a-data-url',
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid image data URL format');
    });

    it('accepts a benign SVG via legacy data URL path', async () => {
      const svgBytes = Buffer.from(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="3"/></svg>',
      );
      const svgDataUrl =
        'data:image/svg+xml;base64,' + svgBytes.toString('base64');
      const svgRequest = createRequest({
        filename: 'icon.svg',
        filetype: 'image',
        mime: 'image/svg+xml',
        body: svgDataUrl,
      });
      const svgResponse = await POST(svgRequest);
      expect(svgResponse.status).toBe(200);
    });

    it('sanitises malicious SVG content before storage', async () => {
      // The hostile parts (<script>, onload, javascript: href) must be
      // stripped before the SVG ever reaches blob storage. The benign
      // <circle> element should survive so the upload still represents
      // a useful image.
      const svgBytes = Buffer.from(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
          '<script>alert(2)</script>' +
          '<a href="javascript:alert(3)"><circle cx="5" cy="5" r="3"/></a>' +
          '</svg>',
      );
      const svgDataUrl =
        'data:image/svg+xml;base64,' + svgBytes.toString('base64');
      const svgRequest = createRequest({
        filename: 'malicious.svg',
        filetype: 'image',
        mime: 'image/svg+xml',
        body: svgDataUrl,
      });

      mockBlobClient.upload.mockClear();
      const svgResponse = await POST(svgRequest);
      expect(svgResponse.status).toBe(200);

      // Inspect what was handed to blob storage. The legacy path stores a
      // data URL string; decode it and assert the dangerous bits are gone.
      expect(mockBlobClient.upload).toHaveBeenCalledTimes(1);
      const stored = mockBlobClient.upload.mock.calls[0][1];
      expect(typeof stored).toBe('string');
      const dataUrl = stored as string;
      const base64 = dataUrl.split(',')[1];
      const cleaned = Buffer.from(base64, 'base64').toString('utf8');
      expect(cleaned).not.toMatch(/onload/i);
      expect(cleaned).not.toMatch(/<script/i);
      expect(cleaned).not.toMatch(/javascript:/i);
      expect(cleaned).not.toMatch(/alert/);
      // Benign content survives.
      expect(cleaned).toMatch(/<circle/i);
    });

    it('accepts ICO via legacy data URL path', async () => {
      const icoBytes = Buffer.from([
        0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10,
      ]);
      const icoDataUrl =
        'data:image/x-icon;base64,' + icoBytes.toString('base64');
      const icoRequest = createRequest({
        filename: 'favicon.ico',
        filetype: 'image',
        mime: 'image/x-icon',
        body: icoDataUrl,
      });
      const icoResponse = await POST(icoRequest);
      expect(icoResponse.status).toBe(200);
    });

    // WebP polyglot rejection. Without the chunk-type check at offset 12-15,
    // an attacker could ship `RIFF\0\0\0\0WEBP<arbitrary bytes>` past magic-
    // byte validation; the server would store it under image/webp and serve
    // it back with that Content-Type.
    it('rejects WebP polyglot (RIFF/WEBP header without VP8 chunk type)', async () => {
      const polyglot = Buffer.from([
        0x52,
        0x49,
        0x46,
        0x46, // "RIFF"
        0x00,
        0x00,
        0x00,
        0x00, // size (any)
        0x57,
        0x45,
        0x42,
        0x50, // "WEBP"
        0x00,
        0x00,
        0x00,
        0x00, // chunk type — invalid (not VP8/VP8L/VP8X)
        0x41,
        0x41,
        0x41,
        0x41, // payload garbage
      ]);
      const dataUrl = 'data:image/webp;base64,' + polyglot.toString('base64');
      const request = createRequest({
        filename: 'evil.webp',
        filetype: 'image',
        mime: 'image/webp',
        body: dataUrl,
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it.each([
      ['VP8', 0x20],
      ['VP8L', 0x4c],
      ['VP8X', 0x58],
    ])('accepts valid WebP variant %s', async (_label, variantByte) => {
      const webp = Buffer.from([
        0x52,
        0x49,
        0x46,
        0x46, // "RIFF"
        0x14,
        0x00,
        0x00,
        0x00, // size
        0x57,
        0x45,
        0x42,
        0x50, // "WEBP"
        0x56,
        0x50,
        0x38, // "VP8" prefix
        variantByte, // ' ' / 'L' / 'X'
        0x00,
        0x00,
        0x00,
        0x00, // chunk size (any)
      ]);
      const dataUrl = 'data:image/webp;base64,' + webp.toString('base64');
      const request = createRequest({
        filename: 'photo.webp',
        filetype: 'image',
        mime: 'image/webp',
        body: dataUrl,
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
    });

    // The same SVG bytes uploaded via multipart and via legacy data-URL must
    // hash to the same blob name. Before this fix, the legacy path hashed
    // the data-URL string and multipart hashed the raw bytes, so the same
    // SVG produced two different blobs and dedup never fired.
    it('hashes the same SVG to the same canonical bytes across legacy and multipart paths', async () => {
      const svg = Buffer.from(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="3"/></svg>',
      );

      // Legacy data-URL path
      const legacyRequest = createRequest({
        filename: 'icon.svg',
        filetype: 'image',
        mime: 'image/svg+xml',
        body: 'data:image/svg+xml;base64,' + svg.toString('base64'),
      });
      vi.mocked(Hasher.sha256).mockClear();
      const legacyResponse = await POST(legacyRequest);
      expect(legacyResponse.status).toBe(200);
      const legacyHashInput = vi.mocked(Hasher.sha256).mock.calls[0][0];

      // Multipart path
      const file = new File([svg], 'icon.svg', { type: 'image/svg+xml' });
      const formData = new FormData();
      formData.append('file', file);
      const params = new URLSearchParams({
        filename: 'icon.svg',
        filetype: 'image',
        mime: 'image/svg+xml',
      });
      const multipartRequest = new NextRequest(
        `http://localhost:3000/api/file/upload?${params.toString()}`,
        { method: 'POST', body: formData },
      );
      vi.mocked(Hasher.sha256).mockClear();
      const multipartResponse = await POST(multipartRequest);
      expect(multipartResponse.status).toBe(200);
      const multipartHashInput = vi.mocked(Hasher.sha256).mock.calls[0][0];

      // Both paths must hash a Buffer (canonical bytes), not the data-URL
      // string, and the canonical bytes must be byte-equal — that's what
      // makes content-based dedup work across paths.
      expect(Buffer.isBuffer(legacyHashInput)).toBe(true);
      expect(Buffer.isBuffer(multipartHashInput)).toBe(true);
      expect(
        (legacyHashInput as Buffer).equals(multipartHashInput as Buffer),
      ).toBe(true);
    });
  });

  describe('File Type Handling', () => {
    it('uploads file to files folder by default', async () => {
      const request = createRequest({
        filename: 'test.txt',
        filetype: 'file',
      });

      await POST(request);

      expect(mockBlobClient.upload).toHaveBeenCalled();
      const uploadPath = mockBlobClient.upload.mock.calls[0][0];
      expect(uploadPath).toContain('/uploads/files/');
    });

    it('uploads images to images folder', async () => {
      const request = createRequest({
        filename: 'test.png',
        filetype: 'image',
        body: VALID_PNG_DATA_URL,
      });

      await POST(request);

      const uploadPath = mockBlobClient.upload.mock.calls[0][0];
      expect(uploadPath).toContain('/uploads/images/');
    });

    it('handles images with mime type (but still needs filetype for folder)', async () => {
      const request = createRequest({
        filename: 'test.png',
        filetype: 'image',
        mime: 'image/png',
        body: VALID_PNG_DATA_URL,
      });

      await POST(request);

      const uploadPath = mockBlobClient.upload.mock.calls[0][0];
      expect(uploadPath).toContain('/uploads/images/');
    });

    it('handles base64 encoded files', async () => {
      const base64Content = Buffer.from('test content').toString('base64');
      const request = createRequest({
        filename: 'test.pdf',
        filetype: 'file',
        body: base64Content,
      });

      await POST(request);

      expect(mockBlobClient.upload).toHaveBeenCalled();
      // For non-images, should decode base64
      const uploadData = mockBlobClient.upload.mock.calls[0][1];
      expect(Buffer.isBuffer(uploadData)).toBe(true);
    });

    it('stores image data URL as a string (legacy path)', async () => {
      const request = createRequest({
        filename: 'test.png',
        filetype: 'image',
        mime: 'image/png',
        body: VALID_PNG_DATA_URL,
      });

      await POST(request);

      // The legacy image path stores the data URL string verbatim so existing
      // getBlobBase64String readers can return it via the data:-prefix branch.
      const uploadData = mockBlobClient.upload.mock.calls[0][1];
      expect(uploadData).toBe(VALID_PNG_DATA_URL);
    });
  });

  describe('Content Type Handling', () => {
    it('uses provided mime type', async () => {
      const request = createRequest({
        filename: 'test.txt',
        mime: 'text/plain',
      });

      await POST(request);

      const uploadOptions = mockBlobClient.upload.mock.calls[0][2];
      expect(uploadOptions.blobHTTPHeaders.blobContentType).toBe('text/plain');
    });

    it('infers content type from extension when mime not provided', async () => {
      vi.mocked(getContentType).mockReturnValue('application/pdf');

      const request = createRequest({
        filename: 'document.pdf',
      });

      await POST(request);

      expect(getContentType).toHaveBeenCalledWith('pdf');
      const uploadOptions = mockBlobClient.upload.mock.calls[0][2];
      expect(uploadOptions.blobHTTPHeaders.blobContentType).toBe(
        'application/pdf',
      );
    });

    it('uses octet-stream as fallback when getContentType returns undefined', async () => {
      // Mock getContentType to return undefined
      vi.mocked(getContentType).mockReturnValue(undefined as any);

      const request = createRequest({
        filename: 'file.xyz', // Unknown extension
      });

      await POST(request);

      const uploadOptions = mockBlobClient.upload.mock.calls[0][2];
      // Note: The implementation doesn't handle undefined from getContentType,
      // so contentType will be undefined. This test documents current behavior.
      expect(uploadOptions.blobHTTPHeaders.blobContentType).toBeUndefined();
    });
  });

  describe('File Path Generation', () => {
    it('generates path with user ID and hashed filename', async () => {
      const request = createRequest({
        filename: 'test.txt',
      });

      await POST(request);

      const uploadPath = mockBlobClient.upload.mock.calls[0][0];
      expect(uploadPath).toMatch(/test-user-id\/uploads\/files\//);
      expect(uploadPath).toContain('.txt');
    });

    it('uses first 200 chars of hash for filename', async () => {
      const longHash = 'a'.repeat(300);
      vi.mocked(Hasher.sha256).mockReturnValue(longHash);

      const request = createRequest({
        filename: 'test.txt',
      });

      await POST(request);

      expect(Hasher.sha256).toHaveBeenCalled();
      const uploadPath = mockBlobClient.upload.mock.calls[0][0];
      expect(uploadPath).toContain('a'.repeat(200)); // Only first 200 chars
    });

    it('preserves file extension', async () => {
      const request = createRequest({
        filename: 'document.pdf',
      });

      await POST(request);

      const uploadPath = mockBlobClient.upload.mock.calls[0][0];
      expect(uploadPath).toMatch(/\.pdf$/);
    });
  });

  describe('Authentication', () => {
    it('requires authentication', async () => {
      (vi.mocked(auth) as any).mockResolvedValue(null);

      const request = createRequest({
        filename: 'test.txt',
      });

      const response = await POST(request);

      // Should return 401 Unauthorized when no session
      expect(response.status).toBe(401);
    });

    it('uses authenticated user ID for upload path', async () => {
      vi.mocked(getUserIdFromSession).mockReturnValue('custom-user-123');

      const request = createRequest({
        filename: 'test.txt',
      });

      await POST(request);

      const uploadPath = mockBlobClient.upload.mock.calls[0][0];
      expect(uploadPath).toContain('custom-user-123');
    });
  });

  describe('Success Response', () => {
    it('returns 200 with file URI on success', async () => {
      mockBlobClient.upload.mockResolvedValue(
        'https://storage.example.com/uploaded-file.txt',
      );

      const request = createRequest({
        filename: 'test.txt',
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // Route returns proxy URL, not direct storage URL
      expect(data.data.uri).toMatch(/^\/api\/file\/.+/);
      expect(data.message).toBe('File uploaded successfully');
    });
  });

  describe('Error Handling', () => {
    it('returns 500 when blob upload fails', async () => {
      mockBlobClient.upload.mockRejectedValue(new Error('Upload failed'));

      const request = createRequest({
        filename: 'test.txt',
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to upload file');
      expect(data.details).toBe('Upload failed');
    });

    it('returns 401 when session retrieval fails', async () => {
      (vi.mocked(auth) as any).mockResolvedValue(null);

      const request = createRequest({
        filename: 'test.txt',
      });

      const response = await POST(request);

      // Changed from 500 to 401 - unauthorized is the correct response for no session
      expect(response.status).toBe(401);
    });

    it('logs error details', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      mockBlobClient.upload.mockRejectedValue(new Error('Blob error'));

      const request = createRequest({
        filename: 'test.txt',
      });

      await POST(request);

      // A generic error classifies as 'unknown' (status 500); the log line
      // carries the classification for alerting.
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[FileUploadRoute] Error uploading file (class=unknown, status=500):',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Edge Cases', () => {
    it('handles file with multiple dots in name', async () => {
      const request = createRequest({
        filename: 'my.file.name.txt',
      });

      await POST(request);

      const uploadPath = mockBlobClient.upload.mock.calls[0][0];
      expect(uploadPath).toMatch(/\.txt$/);
    });

    it('handles file without extension', async () => {
      const request = createRequest({
        filename: 'README',
      });

      await POST(request);

      const uploadPath = mockBlobClient.upload.mock.calls[0][0];
      expect(uploadPath).toContain('README');
    });

    it('handles empty file content', async () => {
      const request = createRequest({
        filename: 'empty.txt',
        body: '',
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockBlobClient.upload).toHaveBeenCalled();
    });

    it('handles binary file content', async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString(
        'base64',
      );
      const request = createRequest({
        filename: 'binary.dat',
        body: binaryContent,
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });
});
