import {
  LibreOfficeFailedError,
  LibreOfficeMemoryError,
  LibreOfficeTimeoutError,
  runLibreOffice,
} from '@/lib/services/documents/render/libreOfficeProcess';
import {
  privateResidentBytes,
  treeResidentBytes,
} from '@/lib/services/documents/render/processMemory';

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The runner around one LibreOffice process: its outcomes are told apart
 * by the output file, not the exit code, and time and memory limits kill
 * the whole process group. Fake launchers stand in for LibreOffice to
 * produce each outcome on demand; the last block runs the real one.
 */

let dir: string;
let input: string;

/** Writes an executable launcher that receives LibreOffice's arguments. */
function launcher(name: string, body: string): string {
  const file = path.join(dir, name);
  // The last two arguments are `--outdir <dir>` and the input; see
  // libreOfficeCommand.
  fs.writeFileSync(
    file,
    `#!/bin/sh\nfor last; do :; done\nout=""\nprev=""\nfor a; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; done\n${body}\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

const job = (binary: string, overrides = {}) => ({
  inputPath: input,
  importFilter: 'Impress MS PowerPoint 2007 XML',
  convertTo: 'pdf',
  outputDir: path.join(dir, 'out'),
  profileDir: path.join(dir, 'profile'),
  timeoutMs: 10_000,
  memoryLimitMb: 512,
  binary,
  ...overrides,
});

/** Whether any process still runs with `marker` in its command line. */
function stillRunning(marker: string): boolean {
  const listing = execFileSync('ps', ['-eo', 'args']).toString();
  return listing
    .split('\n')
    .some((line) => line.includes(marker) && !line.includes('ps -eo'));
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-process-test-'));
  input = path.join(dir, 'deck.pptx');
  fs.writeFileSync(input, 'PK\u0003\u0004');
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runLibreOffice', () => {
  it('returns the output file when one was written', async () => {
    const ok = launcher('ok.sh', 'printf "%%PDF-" > "$out/deck.pdf"');
    await expect(runLibreOffice(job(ok))).resolves.toBe(
      path.join(dir, 'out', 'deck.pdf'),
    );
  });

  it('fails without retry value when it exits 0 but wrote nothing', async () => {
    // LibreOffice's own behaviour on a file it cannot load.
    const empty = launcher(
      'empty.sh',
      'echo "Error: source file could not be loaded"; exit 0',
    );
    fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
    const error = await runLibreOffice(job(empty)).catch((e) => e);
    expect(error).toBeInstanceOf(LibreOfficeFailedError);
    expect(error.crashed).toBe(false);
    expect(error.logs).toContain('could not be loaded');
  });

  it('reports a crash when the process dies', async () => {
    const crash = launcher('crash.sh', 'kill -SEGV $$');
    const error = await runLibreOffice(job(crash)).catch((e) => e);
    expect(error).toBeInstanceOf(LibreOfficeFailedError);
    expect(error.crashed).toBe(true);
  });

  it('kills the whole process group past the time limit', async () => {
    // A child that would outlive its parent, as soffice.bin can.
    const stuck = launcher('stuck.sh', 'sleep 31.7 & sleep 31.7');
    const started = Date.now();
    const error = await runLibreOffice(job(stuck, { timeoutMs: 400 })).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(LibreOfficeTimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stillRunning('sleep 31.7')).toBe(false);
  });

  it('stops on abort and kills the group', async () => {
    const stuck = launcher('abort.sh', 'sleep 32.3 & sleep 32.3');
    const controller = new AbortController();
    const running = runLibreOffice(job(stuck, { signal: controller.signal }));
    setTimeout(() => controller.abort(new Error('stopped by test')), 200);
    await expect(running).rejects.toThrow('stopped by test');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stillRunning('sleep 32.3')).toBe(false);
  });

  it('kills a process group over its memory limit, and leaves one under it', async () => {
    // A child process (as soffice.bin is) holds the memory, so this also
    // shows the whole tree is measured, not only the first process.
    const hungry = launcher(
      'hungry.sh',
      `node -e "const b = Buffer.alloc(200 * 1024 * 1024, 1); setTimeout(() => {}, 4000)"; printf "%%PDF-" > "$out/deck.pdf"`,
    );
    fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
    await expect(
      runLibreOffice(job(hungry, { memoryLimitMb: 120 })),
    ).rejects.toBeInstanceOf(LibreOfficeMemoryError);
    await expect(
      runLibreOffice(job(hungry, { memoryLimitMb: 600 })),
    ).resolves.toContain('deck.pdf');
  }, 20_000);
});

describe('treeResidentBytes', () => {
  it('counts children, and is null where there is no /proc', async () => {
    expect(await treeResidentBytes(process.pid)).toBeGreaterThan(
      10 * 1024 * 1024,
    );
    expect(
      await treeResidentBytes(process.pid, path.join(dir, 'no-proc')),
    ).toBeNull();
  });

  /** A fake /proc: each process with its group, memory and children. */
  function fakeProc(
    name: string,
    processes: Array<{
      pid: number;
      group: number;
      kb: number;
      children?: number[];
    }>,
    withChildrenLists: boolean,
  ): string {
    const root = path.join(dir, name);
    for (const proc of processes) {
      const folder = path.join(root, String(proc.pid));
      fs.mkdirSync(path.join(folder, 'task', String(proc.pid)), {
        recursive: true,
      });
      // The command has a space and a parenthesis, as real ones can.
      fs.writeFileSync(
        path.join(folder, 'stat'),
        `${proc.pid} (soffice (bin)) S 1 ${proc.group} ${proc.group} 0`,
      );
      fs.writeFileSync(
        path.join(folder, 'status'),
        `Name:\tsoffice\nVmRSS:\t  ${proc.kb} kB\n`,
      );
      if (withChildrenLists) {
        fs.writeFileSync(
          path.join(folder, 'task', String(proc.pid), 'children'),
          (proc.children ?? []).join(' '),
        );
      }
    }
    return root;
  }
  const PROCESSES = [
    { pid: 100, group: 100, kb: 1_000, children: [200] }, // the launcher
    { pid: 200, group: 100, kb: 300_000 }, // soffice.bin
    { pid: 300, group: 999, kb: 5_000_000 }, // something else on the machine
  ];

  it('walks the children lists where the kernel has them', async () => {
    const root = fakeProc('proc-tree', PROCESSES, true);
    expect(await treeResidentBytes(100, root)).toBe(301_000 * 1024);
  });

  it('falls back to the process group where it does not', async () => {
    const root = fakeProc('proc-group', PROCESSES, false);
    expect(await treeResidentBytes(100, root)).toBe(301_000 * 1024);
  });

  it('is 0 for a process that has gone', async () => {
    const root = fakeProc('proc-gone', PROCESSES, true);
    expect(await treeResidentBytes(4242, root)).toBe(0);
  });
});

describe('privateResidentBytes', () => {
  // Measured on a desktop with many fonts: 100 MB private, 3.9 GB of
  // mapped font files. Only the private part counts against the limit.
  const status = (rss: number, anon: number, file: number, shmem: number) =>
    `Name:\tsoffice.bin\nVmRSS:\t${rss} kB\nRssAnon:\t${anon} kB\nRssFile:\t${file} kB\nRssShmem:\t${shmem} kB\n`;

  it('counts anonymous and shared-memory pages, not mapped files', () => {
    expect(
      privateResidentBytes(status(4_062_600, 76_948, 3_923_108, 62_544)),
    ).toBe((76_948 + 62_544) * 1024);
  });

  it('keeps a deck that maps 3.9 GB of fonts under a 2 GB limit, and stops one that allocates past it', () => {
    const limit = 2048 * 1024 * 1024;
    expect(
      privateResidentBytes(status(4_062_600, 76_948, 3_923_108, 62_544)),
    ).toBeLessThan(limit);
    expect(
      privateResidentBytes(status(2_200_000, 2_150_000, 50_000, 0)),
    ).toBeGreaterThan(limit);
  });

  it('falls back to VmRSS where the kernel does not split it', () => {
    expect(privateResidentBytes('Name:\tx\nVmRSS:\t1000 kB\n')).toBe(
      1000 * 1024,
    );
    expect(privateResidentBytes('')).toBe(0);
  });
});

const hasLibreOffice = (() => {
  try {
    execFileSync('libreoffice', ['--version'], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasLibreOffice)(
  'runLibreOffice with the real LibreOffice',
  () => {
    let docx: string;
    beforeAll(() => {
      // A real .docx, made by LibreOffice from text.
      const source = path.join(dir, 'note.txt');
      fs.writeFileSync(source, 'Hello from the render test.');
      execFileSync(
        'libreoffice',
        [
          `-env:UserInstallation=file://${path.join(dir, 'make-profile')}`,
          '--headless',
          '--convert-to',
          'docx:MS Word 2007 XML',
          '--outdir',
          dir,
          source,
        ],
        { timeout: 120_000 },
      );
      docx = path.join(dir, 'note.docx');
    }, 130_000);

    const real = (overrides = {}) => ({
      ...job('libreoffice'),
      inputPath: docx,
      importFilter: 'MS Word 2007 XML',
      outputDir: path.join(dir, 'real-out'),
      profileDir: path.join(dir, `real-profile-${Math.random()}`),
      timeoutMs: 120_000,
      ...overrides,
    });

    it('converts within a realistic memory limit', async () => {
      await expect(
        runLibreOffice(real({ memoryLimitMb: 2048 })),
      ).resolves.toContain('note.pdf');
    }, 130_000);

    it('is stopped by a memory limit too small to run in', async () => {
      fs.rmSync(path.join(dir, 'real-out'), { recursive: true, force: true });
      await expect(
        runLibreOffice(real({ memoryLimitMb: 20 })),
      ).rejects.toBeInstanceOf(LibreOfficeMemoryError);
    }, 130_000);
  },
);
