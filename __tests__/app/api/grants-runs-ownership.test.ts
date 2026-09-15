import { NextRequest } from 'next/server';

import { parseJsonResponse } from './helpers';

import { GET as dataGET } from '@/app/api/grants/runs/[runId]/data/route';
import { GET as downloadGET } from '@/app/api/grants/runs/[runId]/download/route';
import { GET as progressGET } from '@/app/api/grants/runs/[runId]/progress/route';
import {
  MAX_SAVE_ROWS,
  POST as savePOST,
} from '@/app/api/grants/runs/[runId]/save/route';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every per-run route checks that the run belongs to the caller. The grants
 * entitlement is broad, so before this any entitled user holding another
 * user's run URL could read, download, or overwrite that run. A foreign run
 * answers exactly like a missing one.
 */

const mockAuth = vi.hoisted(() => vi.fn());
const canUseGrants = vi.hoisted(() => vi.fn());
const runDir = vi.hoisted(() => ({ current: '' }));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/grants/serverAccess', () => ({ canUseGrants }));
vi.mock('@/lib/services/grants/runPaths', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/grants/runPaths')>();
  return { ...actual, grantRunDir: () => runDir.current };
});
vi.mock('@/lib/services/grants/revalidate', () => ({
  revalidateRows: vi.fn(() => undefined),
}));

const RUN_ID = '0f9c2a2e-3b7d-4f1e-9a55-1234567890ab';
const params = Promise.resolve({ runId: RUN_ID });

function request(method: 'GET' | 'POST', body?: unknown, path = 'data') {
  return new NextRequest(
    `http://localhost:3000/api/grants/runs/${RUN_ID}/${path}?file=output`,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  runDir.current = await mkdtemp(join(tmpdir(), 'grant-run-route-'));
  await writeFile(
    join(runDir.current, 'metadata.json'),
    JSON.stringify({ runId: RUN_ID, oc: 'OCA', userId: 'owner' }),
  );
  await writeFile(join(runDir.current, 'output.csv'), 'A,B\n1,2\n');
  canUseGrants.mockResolvedValue(true);
});

afterEach(async () => {
  await rm(runDir.current, { recursive: true, force: true });
});

const asUser = (id: string) => mockAuth.mockResolvedValue({ user: { id } });

describe('grants run routes — ownership', () => {
  it.each([
    ['data', () => dataGET(request('GET'), { params })],
    ['download', () => downloadGET(request('GET'), { params })],
    ['progress', () => progressGET(request('GET'), { params })],
    [
      'save',
      () =>
        savePOST(request('POST', { rows: [{ A: '9', B: '8' }] }), { params }),
    ],
  ] as const)(
    '%s answers 404 for an entitled user who does not own the run',
    async (_route, call) => {
      asUser('someone-else');
      const response = await call();
      expect(response.status).toBe(404);
      expect(await parseJsonResponse(response)).toEqual({
        error: 'Run not found',
      });
    },
  );

  it('save refuses to touch a foreign run on disk', async () => {
    asUser('someone-else');
    await savePOST(request('POST', { rows: [{ A: '9', B: '8' }] }), { params });
    expect(await readFile(join(runDir.current, 'output.csv'), 'utf-8')).toBe(
      'A,B\n1,2\n',
    );
  });

  it('the owner reads, downloads, polls, and saves normally', async () => {
    asUser('owner');
    expect((await dataGET(request('GET'), { params })).status).toBe(200);
    expect((await downloadGET(request('GET'), { params })).status).toBe(200);
    expect((await progressGET(request('GET'), { params })).status).toBe(200);
    const saved = await savePOST(
      request('POST', { rows: [{ A: '9', B: '8' }] }),
      { params },
    );
    expect(saved.status).toBe(200);
    expect(await readFile(join(runDir.current, 'output.csv'), 'utf-8')).toBe(
      'A,B\n9,8',
    );
  });
});

describe('grants run save — payload bounds', () => {
  beforeEach(() => asUser('owner'));

  it('rejects more rows than the cap with 413', async () => {
    const rows = Array.from({ length: MAX_SAVE_ROWS + 1 }, () => ({ A: 'x' }));
    const response = await savePOST(request('POST', { rows }), { params });
    expect(response.status).toBe(413);
  });

  it('rejects rows that are not objects', async () => {
    const response = await savePOST(request('POST', { rows: ['x'] }), {
      params,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a body that is not JSON', async () => {
    const bad = new NextRequest(
      `http://localhost:3000/api/grants/runs/${RUN_ID}/save`,
      { method: 'POST', body: '{nope' },
    );
    const response = await savePOST(bad, { params });
    expect(response.status).toBe(400);
  });
});
