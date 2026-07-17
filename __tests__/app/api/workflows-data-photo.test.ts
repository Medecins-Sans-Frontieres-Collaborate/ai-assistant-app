import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/workflows/data/photo/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockCallStructured = vi.hoisted(() => vi.fn());
const mockGetBlobBase64String = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/shared/workflowLlm', () => ({
  callStructured: mockCallStructured,
  createAzureClient: vi.fn(() => ({})),
}));
vi.mock('@/lib/utils/server/blob/blob', () => ({
  getBlobBase64String: mockGetBlobBase64String,
}));

const SHA = 'a'.repeat(64);
const VALID_REF = `/api/file/${SHA}.jpg`;

function request(body: unknown) {
  return createMockRequest({
    method: 'POST',
    url: 'http://localhost:3000/api/workflows/data/photo',
    body,
  });
}

describe('/api/workflows/data/photo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(createMockSession());
    mockGetBlobBase64String.mockResolvedValue('data:image/jpeg;base64,QUJD');
  });

  it('rejects unauthenticated requests', async () => {
    mockAuth.mockResolvedValue(null);
    const response = await POST(
      request({ imageRefs: [VALID_REF], mode: 'infer' }),
    );
    expect(response.status).toBe(401);
  });

  it.each([
    ['path traversal', `/api/file/../${SHA}.jpg`],
    ['non-hex hash', `/api/file/${'z'.repeat(64)}.jpg`],
    ['short hash', '/api/file/abc123.jpg'],
    ['long extension', `/api/file/${SHA}.jpeg2000`],
    ['external url', `https://evil.example/${SHA}.jpg`],
  ])('rejects invalid image refs (%s)', async (_label, ref) => {
    const response = await POST(request({ imageRefs: [ref], mode: 'infer' }));
    expect(response.status).toBe(400);
    expect(mockGetBlobBase64String).not.toHaveBeenCalled();
  });

  it('rejects more than 10 images and empty ref lists', async () => {
    const many = Array.from({ length: 11 }, () => VALID_REF);
    expect(
      (await POST(request({ imageRefs: many, mode: 'infer' }))).status,
    ).toBe(400);
    expect((await POST(request({ imageRefs: [], mode: 'infer' }))).status).toBe(
      400,
    );
  });

  it('rejects extract mode without valid columns', async () => {
    const response = await POST(
      request({ imageRefs: [VALID_REF], mode: 'extract' }),
    );
    expect(response.status).toBe(400);

    const badType = await POST(
      request({
        imageRefs: [VALID_REF],
        mode: 'extract',
        columns: [{ id: 'a', name: 'A', type: 'geojson' }],
      }),
    );
    expect(badType.status).toBe(400);
  });

  it('rejects oversized images after blob fetch', async () => {
    mockGetBlobBase64String.mockResolvedValue(
      `data:image/jpeg;base64,${'Q'.repeat(8 * 1024 * 1024)}`,
    );
    const response = await POST(
      request({ imageRefs: [VALID_REF], mode: 'infer' }),
    );
    expect(response.status).toBe(400);
  });

  it('infer mode: sends text + image parts and returns the inference', async () => {
    const inference = {
      kind: 'record',
      columns: [{ name: 'Name', type: 'text', required: true }],
      rows: [{ values: ['Amina'] }],
      notes: '',
    };
    mockCallStructured.mockResolvedValue(inference);

    const response = await POST(
      request({ imageRefs: [VALID_REF, VALID_REF], mode: 'infer' }),
    );
    const parsed = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(parsed.data).toEqual(inference);

    const call = mockCallStructured.mock.calls[0][0];
    expect(call.schemaName).toBe('photo_infer');
    expect(Array.isArray(call.user)).toBe(true);
    expect(call.user[0].type).toBe('text');
    expect(
      call.user.filter((p: { type: string }) => p.type === 'image_url'),
    ).toHaveLength(2);
    expect(call.user[1].image_url.detail).toBe('high');
    // Blob id (with extension) passed into the user-namespaced fetch.
    expect(mockGetBlobBase64String).toHaveBeenCalledWith(
      expect.any(String),
      `${SHA}.jpg`,
      'images',
      expect.anything(),
    );
  });

  it('extract mode: uses the fixed-schema extraction shape', async () => {
    mockCallStructured.mockResolvedValue({ rows: [{ name: 'Amina' }] });
    const response = await POST(
      request({
        imageRefs: [VALID_REF],
        mode: 'extract',
        columns: [{ id: 'name', name: 'Name', type: 'text', required: true }],
      }),
    );
    const parsed = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(parsed.data.rows).toEqual([{ name: 'Amina' }]);
    expect(mockCallStructured.mock.calls[0][0].schemaName).toBe(
      'photo_extract',
    );
  });
});
