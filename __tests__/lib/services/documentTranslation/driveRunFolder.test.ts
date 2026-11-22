import { NextRequest } from 'next/server';

import { DriveRunFolder } from '@/lib/services/documentTranslation/native/nativeRunBackends';
import { M365Error, mintGraphToken } from '@/lib/services/m365/graphApi';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// graphApi statically imports @/auth (next-auth), which cannot load in the
// node test environment — and mintGraphToken is mocked anyway.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getGraphAccessToken: vi.fn(),
}));

vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return { ...actual, mintGraphToken: vi.fn() };
});

const RUN_ID = '0b5e6a52-6a0b-4f4c-9b0e-3d2f8f6f1a10';
const request = () => new NextRequest('http://localhost/api/test');
const fetchMock = vi.fn<typeof fetch>();

/** Graph's answer for a file's metadata, then the file's content. */
const fileAnswers = (content: string) => [
  new Response(
    JSON.stringify({ '@microsoft.graph.downloadUrl': 'https://dl/x' }),
    { status: 200 },
  ),
  new Response(content, { status: 200 }),
];

/** The bearer token each Graph call carried, in order. */
const tokensSent = (): Array<string | undefined> =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).startsWith('https://graph.microsoft.com'))
    .map(
      ([, init]) =>
        (init?.headers as Record<string, string> | undefined)?.Authorization,
    );

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.mocked(mintGraphToken).mockReset();
});

describe('DriveRunFolder: Graph tokens', () => {
  it('mints one token for every call a folder makes', async () => {
    vi.mocked(mintGraphToken).mockResolvedValue('token-1');
    fetchMock
      .mockResolvedValueOnce(fileAnswers('a')[0])
      .mockResolvedValueOnce(fileAnswers('a')[1])
      .mockResolvedValueOnce(fileAnswers('b')[0])
      .mockResolvedValueOnce(fileAnswers('b')[1]);
    const folder = await DriveRunFolder.open(request(), RUN_ID);

    expect((await folder.read('a.png'))?.toString()).toBe('a');
    expect((await folder.read('b.png'))?.toString()).toBe('b');
    // Opening and two reads: one mint, and each Graph call carried it.
    expect(mintGraphToken).toHaveBeenCalledTimes(1);
    expect(tokensSent()).toEqual(['Bearer token-1', 'Bearer token-1']);
    // The pre-authenticated download link is fetched without the token.
    expect(fetchMock.mock.calls[1][1]).toBeUndefined();
  });

  it('mints again and repeats the call once when Graph rejects the token', async () => {
    vi.mocked(mintGraphToken)
      .mockResolvedValueOnce('expired')
      .mockResolvedValueOnce('fresh');
    const [meta, content] = fileAnswers('ok');
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(meta)
      .mockResolvedValueOnce(content);
    const folder = await DriveRunFolder.open(request(), RUN_ID);

    expect((await folder.read('a.png'))?.toString()).toBe('ok');
    expect(mintGraphToken).toHaveBeenCalledTimes(2);
    expect(tokensSent()).toEqual(['Bearer expired', 'Bearer fresh']);
  });

  it('repeats a rejected call only once', async () => {
    vi.mocked(mintGraphToken).mockResolvedValue('rejected');
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    const folder = await DriveRunFolder.open(request(), RUN_ID);

    await expect(folder.read('a.png')).rejects.toBeInstanceOf(M365Error);
    expect(tokensSent()).toHaveLength(2);
  });

  it('fails to open without a grant, and does not keep the failed mint', async () => {
    const denied = new M365Error('No grant', 'consent_missing', 403);
    vi.mocked(mintGraphToken).mockRejectedValueOnce(denied);
    await expect(DriveRunFolder.open(request(), RUN_ID)).rejects.toBe(denied);

    vi.mocked(mintGraphToken).mockResolvedValue('token-2');
    const folder = await DriveRunFolder.open(request(), RUN_ID);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await folder.read('missing.png')).toBeNull();
    expect(tokensSent()).toEqual(['Bearer token-2']);
  });
});
