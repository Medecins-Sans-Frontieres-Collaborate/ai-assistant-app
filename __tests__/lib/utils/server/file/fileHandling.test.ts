import { loadDocumentFromPath } from '@/lib/utils/server/file/fileHandling';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
const readdirMock = vi.fn();
const readFileMock = vi.fn();
const mkdtempMock = vi.fn();
const rmMock = vi.fn();
const unlinkMock = vi.fn();
const writeFileMock = vi.fn();

vi.mock('child_process', () => ({
  execFile: (
    cmd: string,
    args: readonly string[],
    opts: unknown,
    cb: (
      err: Error | null,
      res: { stdout: string; stderr: string } | null,
    ) => void,
  ) => {
    Promise.resolve(execFileMock(cmd, args, opts)).then(
      (res) => cb(null, res ?? { stdout: '', stderr: '' }),
      (err) =>
        cb(err instanceof Error ? err : new Error(String(err)), {
          stdout: '',
          stderr: '',
        }),
    );
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        readdir: (...args: unknown[]) => readdirMock(...args),
        readFile: (...args: unknown[]) => readFileMock(...args),
        mkdtemp: (...args: unknown[]) => mkdtempMock(...args),
        rm: (...args: unknown[]) => rmMock(...args),
        unlink: (...args: unknown[]) => unlinkMock(...args),
        writeFile: (...args: unknown[]) => writeFileMock(...args),
      },
    },
  };
});

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

beforeEach(() => {
  execFileMock.mockReset();
  readdirMock.mockReset();
  readFileMock.mockReset();
  mkdtempMock.mockReset();
  rmMock.mockReset();
  unlinkMock.mockReset();
  writeFileMock.mockReset();
  rmMock.mockResolvedValue(undefined);
  unlinkMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
});

describe('legacy Office / HTML routing via loadDocumentFromPath', () => {
  it('routes .doc through LibreOffice → docx → pandoc instead of raw UTF-8', async () => {
    mkdtempMock.mockResolvedValue('/tmp/doc-1');
    const calls: string[] = [];
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      calls.push(cmd);
      if (cmd === 'libreoffice') {
        expect(args).toContain('--convert-to');
        expect(args).toContain('docx');
        expect(args.some((a) => a.startsWith('-env:UserInstallation='))).toBe(
          true,
        );
      }
      if (cmd === 'pandoc') {
        expect(args[0]).toBe('/tmp/doc-1/memo.docx');
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    readdirMock.mockResolvedValue(['memo.docx']);
    readFileMock.mockResolvedValue('# Memo\n\nBody text');

    const out = await loadDocumentFromPath(
      '/input/memo.doc',
      'application/msword',
      'memo.doc',
    );
    expect(calls).toEqual(['libreoffice', 'pandoc']);
    expect(out).toBe('# Memo\n\nBody text');
    expect(rmMock).toHaveBeenCalledWith(
      '/tmp/doc-1',
      expect.objectContaining({ recursive: true }),
    );
  });

  it('fails loudly when LibreOffice produces nothing for a .doc', async () => {
    mkdtempMock.mockResolvedValue('/tmp/doc-2');
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    readdirMock.mockResolvedValue([]);
    await expect(
      loadDocumentFromPath('/input/x.doc', 'application/msword', 'x.doc'),
    ).rejects.toThrow(/did not produce x\.docx/);
  });

  it('routes legacy .xls through ssconvert like .xlsx', async () => {
    mkdtempMock.mockResolvedValue('/tmp/xlsx-legacy');
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      expect(cmd).toBe('ssconvert');
      if (args.includes('--list-sheets')) {
        return Promise.resolve({
          stdout: 'Sheet names in [old.xls]:\nData\n',
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    readdirMock.mockResolvedValue(['old_.csv.0']);
    readFileMock.mockResolvedValue('a,b\n');
    const out = await loadDocumentFromPath(
      '/input/old.xls',
      'application/vnd.ms-excel',
      'old.xls',
    );
    expect(out).toContain('--- START OF SHEET: Data ---');
  });

  it('reads an unknown-type script (generated .vbs, octet-stream) as plain text — issue #126', async () => {
    readFileMock.mockResolvedValue('MsgBox "hello"\r\nWScript.Quit');
    const out = await loadDocumentFromPath(
      '/input/script.vbs',
      'application/octet-stream',
      'script.vbs',
    );
    expect(out).toContain('MsgBox "hello"');
    // No converter is involved for plain text.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('converts HTML with pandoc (explicit html reader, no raw passthrough)', async () => {
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      expect(cmd).toBe('pandoc');
      expect(args).toEqual([
        '/input/page.html',
        '-f',
        'html',
        '-t',
        'markdown-raw_html',
        '-o',
        '/input/page.html.markdown',
      ]);
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    readFileMock.mockResolvedValue('Heading\n=======\n\nProse');
    const out = await loadDocumentFromPath(
      '/input/page.html',
      'text/html',
      'page.html',
    );
    expect(out).toBe('Heading\n=======\n\nProse');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('forwards an AbortSignal to the converter child', async () => {
    const controller = new AbortController();
    execFileMock.mockImplementation(
      (_cmd: string, _args: readonly string[], opts: { signal?: unknown }) => {
        expect(opts.signal).toBe(controller.signal);
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    );
    readFileMock.mockResolvedValue('x');
    await loadDocumentFromPath(
      '/input/a.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'a.docx',
      {
        signal: controller.signal,
      },
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe('xlsxToText via loadDocumentFromPath', () => {
  it('labels sheets with real names from ssconvert --list-sheets', async () => {
    mkdtempMock.mockResolvedValue('/tmp/xlsx-abc');
    execFileMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args.includes('--list-sheets')) {
        return Promise.resolve({
          stdout: 'Sheet names in [foo.xlsx]:\nRevenue\nForecast\n',
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    readdirMock.mockResolvedValue(['foo_.csv.0', 'foo_.csv.1']);
    readFileMock.mockImplementation((p: string) => {
      if (p.endsWith('.0')) return Promise.resolve('Q1,100\n');
      if (p.endsWith('.1')) return Promise.resolve('Plan,200\n');
      return Promise.resolve('');
    });

    const out = await loadDocumentFromPath(
      '/input/foo.xlsx',
      XLSX_MIME,
      'foo.xlsx',
    );

    expect(out).toContain('--- START OF SHEET: Revenue ---');
    expect(out).toContain('--- START OF SHEET: Forecast ---');
    expect(out).not.toMatch(/SHEET:\s*\.\d/);
    expect(out.indexOf('Revenue')).toBeLessThan(out.indexOf('Forecast'));
  });

  it('orders sheets numerically, not lexically (11+ sheets)', async () => {
    mkdtempMock.mockResolvedValue('/tmp/xlsx-xyz');
    const sheetNames = Array.from({ length: 11 }, (_, i) => `S${i}`);
    execFileMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args.includes('--list-sheets')) {
        return Promise.resolve({
          stdout: 'Sheet names in [x.xlsx]:\n' + sheetNames.join('\n') + '\n',
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    // Lexically sorted directory order: ".0", ".1", ".10", ".2", ".3", ...
    const files = Array.from({ length: 11 }, (_, i) => `x_.csv.${i}`).sort();
    readdirMock.mockResolvedValue(files);
    readFileMock.mockImplementation((p: string) => {
      const m = p.match(/\.(\d+)$/);
      return Promise.resolve(`content-${m?.[1]}\n`);
    });

    const out = await loadDocumentFromPath(
      '/input/x.xlsx',
      XLSX_MIME,
      'x.xlsx',
    );

    const idxS2 = out.indexOf('S2 ---');
    const idxS10 = out.indexOf('S10 ---');
    expect(idxS2).toBeGreaterThan(-1);
    expect(idxS10).toBeGreaterThan(-1);
    // S2 must come before S10 (lexical sort would reverse this)
    expect(idxS2).toBeLessThan(idxS10);
  });

  it('falls back to "Sheet N" labels when --list-sheets fails', async () => {
    mkdtempMock.mockResolvedValue('/tmp/xlsx-f');
    execFileMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args.includes('--list-sheets')) {
        return Promise.reject(new Error('ssconvert: option not recognised'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    readdirMock.mockResolvedValue(['f_.csv.0']);
    readFileMock.mockResolvedValue('a,b\n');

    const out = await loadDocumentFromPath(
      '/input/f.xlsx',
      XLSX_MIME,
      'f.xlsx',
    );

    expect(out).toContain('--- START OF SHEET: Sheet 1 ---');
  });

  it('truncates extracted output when it exceeds the size cap', async () => {
    mkdtempMock.mockResolvedValue('/tmp/xlsx-big');
    execFileMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args.includes('--list-sheets')) {
        return Promise.resolve({
          stdout: 'Sheet names in [big.xlsx]:\nA\nB\nC\n',
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    readdirMock.mockResolvedValue(['big_.csv.0', 'big_.csv.1', 'big_.csv.2']);
    // Each sheet is 15MB — the combined size blows past the 20MB cap.
    const fifteenMb = 'x'.repeat(15 * 1024 * 1024);
    readFileMock.mockResolvedValue(fifteenMb);

    const out = await loadDocumentFromPath(
      '/input/big.xlsx',
      XLSX_MIME,
      'big.xlsx',
    );

    expect(out).toContain('--- START OF SHEET: A ---');
    expect(out).toMatch(/truncated at 20MB/);
    // A full output without truncation would be ~45MB; we must stay within ~20MB
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(23 * 1024 * 1024);
  });

  it('cleans up temp directory even on conversion failure', async () => {
    mkdtempMock.mockResolvedValue('/tmp/xlsx-fail');
    execFileMock.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args.includes('--list-sheets')) {
        return Promise.resolve({
          stdout: 'Sheet names in [bad.xlsx]:\nOne\n',
          stderr: '',
        });
      }
      return Promise.reject(new Error('ssconvert crashed'));
    });

    await expect(
      loadDocumentFromPath('/input/bad.xlsx', XLSX_MIME, 'bad.xlsx'),
    ).rejects.toThrow(/ssconvert crashed/);
    expect(rmMock).toHaveBeenCalledWith(
      '/tmp/xlsx-fail',
      expect.objectContaining({ recursive: true, force: true }),
    );
  });
});
