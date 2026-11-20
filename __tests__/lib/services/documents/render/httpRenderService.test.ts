import { HttpRenderService } from '@/lib/services/documents/render/httpRenderService';
import { DocumentSignatureError } from '@/lib/services/documents/render/libreOfficeInputs';
import { LibreOfficeTimeoutError } from '@/lib/services/documents/render/libreOfficeProcess';
import { RenderBusyError } from '@/lib/services/documents/render/renderQueue';

import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * The HTTP render service client against a fake service that follows the
 * contract in docs/RENDER_SERVICE.md: a job is created with its file,
 * followed while it waits and runs, and its files fetched; errors arrive
 * as the same errors as in process.
 */

type Script = {
  /** Answer to POST /jobs: a status and body. */
  create: () => { status: number; body: unknown };
  /** States GET /jobs/:id answers in turn; the last repeats. */
  states: unknown[];
  files: Record<string, string>;
};

let script: Script;
const seen: Array<{
  method: string;
  url: string;
  auth?: string;
  fields?: string;
}> = [];
let server: http.Server;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-render-'));
  fs.writeFileSync(path.join(dir, 'deck.pptx'), 'PK deck');
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        auth: req.headers.authorization,
        fields: req.method === 'POST' ? body : undefined,
      });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'POST' && req.url === '/jobs') {
        const { status, body: answer } = script.create();
        return send(status, answer);
      }
      const file = /^\/jobs\/j1\/files\/(.+)$/.exec(req.url!);
      if (req.method === 'GET' && file) {
        res.writeHead(200);
        return res.end(script.files[decodeURIComponent(file[1])]);
      }
      if (req.method === 'GET' && req.url === '/jobs/j1') {
        return send(
          200,
          script.states.length > 1 ? script.states.shift() : script.states[0],
        );
      }
      if (req.method === 'DELETE')
        return send(200, { id: 'j1', state: 'cancelled' });
      if (req.url === '/queue') {
        return send(200, {
          running: 1,
          queued: { interactive: 0, translation: 4 },
          maxConcurrent: 2,
          averageRunMs: { interactive: null, translation: 9000 },
        });
      }
      send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  seen.length = 0;
});

const client = () =>
  new HttpRenderService({ url: base, token: 'secret-t', pollMs: 5 });

describe('HttpRenderService', () => {
  it('converts: waits in the queue, reports its place, and saves the result', async () => {
    script = {
      create: () => ({
        status: 202,
        body: { id: 'j1', state: 'waiting', ahead: 2 },
      }),
      states: [
        { id: 'j1', state: 'waiting', ahead: 1 },
        { id: 'j1', state: 'running' },
        { id: 'j1', state: 'done', files: [{ name: 'deck.pdf' }] },
      ],
      files: { 'deck.pdf': '%PDF-converted' },
    };
    const positions: number[] = [];
    const out = await client().convert({
      inputPath: path.join(dir, 'deck.pptx'),
      type: 'pptx',
      convertTo: 'pdf',
      outputDir: path.join(dir, 'out'),
      lane: 'translation',
      onPosition: (ahead) => positions.push(ahead),
    });
    expect(fs.readFileSync(out, 'utf8')).toBe('%PDF-converted');
    expect(positions).toEqual([2, 1, 0]);
    const created = seen.find((r) => r.method === 'POST')!;
    expect(created.auth).toBe('Bearer secret-t');
    for (const field of ['convert', 'pptx', 'translation', 'PK deck']) {
      expect(created.fields).toContain(field);
    }
  });

  it('rasterizes: pages come back by number', async () => {
    script = {
      create: () => ({ status: 202, body: { id: 'j1', state: 'running' } }),
      states: [
        {
          id: 'j1',
          state: 'done',
          files: [
            { name: 'page-3.png', page: 3 },
            { name: 'page-1.png', page: 1 },
          ],
        },
      ],
      files: { 'page-3.png': 'p3', 'page-1.png': 'p1' },
    };
    const pages = await client().rasterize({
      pdfPath: path.join(dir, 'deck.pptx'),
      pages: [1, 3],
      dpi: 144,
      outputDir: path.join(dir, 'pictures'),
      lane: 'translation',
    });
    expect(fs.readFileSync(pages.get(3)!, 'utf8')).toBe('p3');
    expect(fs.readFileSync(pages.get(1)!, 'utf8')).toBe('p1');
  });

  it('keeps file names from the service inside the output folder', async () => {
    script = {
      create: () => ({
        status: 202,
        body: {
          id: 'j1',
          state: 'done',
          files: [{ name: '../../escape.pdf' }],
        },
      }),
      states: [
        { id: 'j1', state: 'done', files: [{ name: '../../escape.pdf' }] },
      ],
      files: { 'escape.pdf': 'x' },
    };
    const out = await client().convert({
      inputPath: path.join(dir, 'deck.pptx'),
      type: 'pptx',
      convertTo: 'pdf',
      outputDir: path.join(dir, 'safe'),
      lane: 'interactive',
    });
    expect(path.dirname(out)).toBe(path.join(dir, 'safe'));
  });

  it.each([
    [
      503,
      { code: 'RENDER_BUSY', error: 'busy', details: { queued: 200 } },
      RenderBusyError,
    ],
    [
      422,
      {
        code: 'DOCUMENT_PROTECTED',
        error: 'protected',
        details: { type: 'pptx' },
      },
      DocumentSignatureError,
    ],
  ])(
    'a refused job (%i) is the in-process error',
    async (status, body, kind) => {
      script = { create: () => ({ status, body }), states: [], files: {} };
      await expect(
        client().convert({
          inputPath: path.join(dir, 'deck.pptx'),
          type: 'pptx',
          convertTo: 'pdf',
          outputDir: dir,
          lane: 'interactive',
        }),
      ).rejects.toBeInstanceOf(kind);
    },
  );

  it('a job that fails on the service is the in-process error', async () => {
    script = {
      create: () => ({ status: 202, body: { id: 'j1', state: 'running' } }),
      states: [
        {
          id: 'j1',
          state: 'failed',
          error: { code: 'RENDER_TIMEOUT', message: 'too slow' },
        },
      ],
      files: {},
    };
    await expect(
      client().convert({
        inputPath: path.join(dir, 'deck.pptx'),
        type: 'pptx',
        convertTo: 'pdf',
        outputDir: dir,
        lane: 'translation',
      }),
    ).rejects.toBeInstanceOf(LibreOfficeTimeoutError);
  });

  it('cancels the job on the service when the caller stops', async () => {
    script = {
      create: () => ({
        status: 202,
        body: { id: 'j1', state: 'waiting', ahead: 5 },
      }),
      states: [{ id: 'j1', state: 'waiting', ahead: 5 }],
      files: {},
    };
    const stop = new AbortController();
    const job = client().convert({
      inputPath: path.join(dir, 'deck.pptx'),
      type: 'pptx',
      convertTo: 'pdf',
      outputDir: dir,
      lane: 'translation',
      signal: stop.signal,
      onPosition: () => setTimeout(() => stop.abort(new Error('stopped')), 10),
    });
    await expect(job).rejects.toThrow('stopped');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      seen.some((r) => r.method === 'DELETE' && r.url === '/jobs/j1'),
    ).toBe(true);
  });

  it('reports the service’s queue once it has been read', async () => {
    const service = client();
    service.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.snapshot()).toMatchObject({
      maxConcurrent: 2,
      queued: { translation: 4 },
    });
  });
});
