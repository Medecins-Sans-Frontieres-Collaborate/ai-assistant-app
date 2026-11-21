import {
  DocumentSignatureError,
  checkLibreOfficeInput,
  signatureOf,
} from '@/lib/services/documents/render/libreOfficeInputs';
import {
  LibreOfficeConversion,
  LibreOfficeFailedError,
  LibreOfficeTimeoutError,
} from '@/lib/services/documents/render/libreOfficeProcess';
import { RenderBusyError } from '@/lib/services/documents/render/renderQueue';
import {
  InProcessRenderService,
  InProcessRenderSettings,
  STALE_WORK_MS,
  getRenderService,
  timeLimitFor,
} from '@/lib/services/documents/render/renderService';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The render service: the one way the server runs LibreOffice. Its
 * conversions here are stand-ins (the process itself is tested in
 * libreOfficeProcess.test.ts); what is tested is what it allows to run,
 * when, how often, and what it cleans up.
 */

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

let dir: string;
let deck: string;
let encrypted: string;
let junk: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-service-test-'));
  deck = path.join(dir, 'deck.pptx');
  fs.writeFileSync(deck, ZIP);
  encrypted = path.join(dir, 'locked.pptx');
  fs.writeFileSync(encrypted, CFB);
  junk = path.join(dir, 'junk.pptx');
  fs.writeFileSync(junk, Buffer.from('not a deck at all'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const settings = (overrides: Partial<InProcessRenderSettings> = {}) => ({
  maxConcurrent: 1,
  maxQueued: 10,
  interactiveBurst: 3,
  memoryLimitMb: 1024,
  timeoutBaseMs: 60_000,
  timeoutPerMbMs: 2_000,
  timeoutMaxMs: 600_000,
  workRoot: path.join(dir, 'work'),
  ...overrides,
});

const request = (overrides = {}) => ({
  inputPath: deck,
  type: 'pptx',
  convertTo: 'pdf',
  outputDir: path.join(dir, 'out'),
  lane: 'background' as const,
  ...overrides,
});

describe('input checks', () => {
  it('reads each container from its first bytes', () => {
    expect(signatureOf(ZIP)).toBe('zip');
    expect(signatureOf(CFB)).toBe('cfb');
    expect(signatureOf(Buffer.from('{\\rtf1\\ansi'))).toBe('rtf');
    expect(signatureOf(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(signatureOf(Buffer.from('PK'))).toBe('unknown'); // too short
  });

  it('says a compound file named .pptx is protected, and junk is unreadable', async () => {
    await expect(checkLibreOfficeInput(deck, 'pptx')).resolves.toMatchObject({
      filter: 'Impress MS PowerPoint 2007 XML',
    });
    await expect(
      checkLibreOfficeInput(encrypted, 'pptx'),
    ).rejects.toMatchObject({
      code: 'DOCUMENT_PROTECTED',
    });
    await expect(checkLibreOfficeInput(junk, 'pptx')).rejects.toMatchObject({
      code: 'DOCUMENT_UNREADABLE',
    });
    // The same compound file is exactly what a .ppt must be.
    await expect(
      checkLibreOfficeInput(encrypted, 'ppt'),
    ).resolves.toMatchObject({
      filter: 'MS PowerPoint 97',
    });
  });

  it('refuses types LibreOffice is not used for', async () => {
    await expect(checkLibreOfficeInput(deck, 'exe')).rejects.toThrow('.exe');
  });
});

describe('timeLimitFor', () => {
  it('grows with the file and stops at the cap', () => {
    const limits = settings();
    expect(timeLimitFor(0, limits)).toBe(60_000);
    expect(timeLimitFor(37 * 1024 * 1024, limits)).toBe(134_000);
    expect(timeLimitFor(10_000 * 1024 * 1024, limits)).toBe(600_000);
  });
});

describe('InProcessRenderService', () => {
  it('checks the file before queueing: junk never takes a slot', async () => {
    const run = vi.fn();
    const service = new InProcessRenderService(settings(), run);
    await expect(
      service.convert(request({ inputPath: junk })),
    ).rejects.toBeInstanceOf(DocumentSignatureError);
    expect(run).not.toHaveBeenCalled();
  });

  it('opens the file with its import filter and a fresh profile each time', async () => {
    const jobs: LibreOfficeConversion[] = [];
    const service = new InProcessRenderService(settings(), async (job) => {
      jobs.push(job);
      return path.join(job.outputDir, 'deck.pdf');
    });
    await service.convert(request());
    await service.convert(request());
    expect(jobs[0].importFilter).toBe('Impress MS PowerPoint 2007 XML');
    expect(jobs[0].memoryLimitMb).toBe(1024);
    expect(jobs[0].timeoutMs).toBe(60_000);
    expect(jobs[0].profileDir).not.toBe(jobs[1].profileDir);
  });

  it('tries a crash once more, and then gives up', async () => {
    const crash = () => new LibreOfficeFailedError('died', true, '');
    let calls = 0;
    const recovers = new InProcessRenderService(settings(), async () => {
      calls += 1;
      if (calls === 1) throw crash();
      return 'out.pdf';
    });
    await expect(recovers.convert(request())).resolves.toBe('out.pdf');
    expect(calls).toBe(2);

    const run = vi.fn().mockRejectedValue(crash());
    const keepsCrashing = new InProcessRenderService(settings(), run);
    await expect(keepsCrashing.convert(request())).rejects.toBeInstanceOf(
      LibreOfficeFailedError,
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry what would fail the same way', async () => {
    for (const error of [
      new LibreOfficeFailedError('cannot read', false, ''),
      new LibreOfficeTimeoutError(1_000),
    ]) {
      const run = vi.fn().mockRejectedValue(error);
      const service = new InProcessRenderService(settings(), run);
      await expect(service.convert(request())).rejects.toBe(error);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it('removes each job profile afterwards, success or not', async () => {
    const profiles: string[] = [];
    const service = new InProcessRenderService(settings(), async (job) => {
      fs.mkdirSync(job.profileDir, { recursive: true });
      profiles.push(job.profileDir);
      if (profiles.length === 2)
        throw new LibreOfficeFailedError('x', false, '');
      return 'ok';
    });
    await service.convert(request());
    await service.convert(request()).catch(() => undefined);
    for (const profile of profiles) {
      expect(fs.existsSync(path.dirname(profile))).toBe(false);
    }
  });

  it('runs one conversion at a time and refuses past the queue limit', async () => {
    let running = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const service = new InProcessRenderService(
      settings({ maxConcurrent: 1, maxQueued: 2 }),
      async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
        return 'ok';
      },
    );
    const accepted = [
      service.convert(request()),
      service.convert(request()),
      service.convert(request()),
    ];
    // Signature checks are asynchronous; let all three reach the queue.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(service.convert(request())).rejects.toBeInstanceOf(
      RenderBusyError,
    );
    expect(service.snapshot()).toMatchObject({
      running: 1,
      queued: { interactive: 0, background: 2 },
    });
    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(Promise.all(accepted)).resolves.toEqual(['ok', 'ok', 'ok']);
    expect(most).toBe(1);
  });

  it('removes leftovers older than an hour, and keeps younger ones', async () => {
    const limits = settings({ workRoot: path.join(dir, 'leftovers') });
    const old = path.join(limits.workRoot, 'job-old');
    const young = path.join(limits.workRoot, 'job-young');
    const other = path.join(limits.workRoot, 'not-a-job');
    for (const folder of [old, young, other])
      fs.mkdirSync(folder, { recursive: true });
    const now = Date.now();
    const at = (ms: number) => new Date(now - ms);
    fs.utimesSync(old, at(STALE_WORK_MS + 60_000), at(STALE_WORK_MS + 60_000));
    fs.utimesSync(
      young,
      at(STALE_WORK_MS - 60_000),
      at(STALE_WORK_MS - 60_000),
    );
    fs.utimesSync(other, at(STALE_WORK_MS * 5), at(STALE_WORK_MS * 5));

    const service = new InProcessRenderService(limits, vi.fn());
    expect(await service.removeLeftovers(now)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });
});

describe('getRenderService', () => {
  it('is one service per process, however often it is asked for', () => {
    expect(getRenderService()).toBe(getRenderService());
  });
});
