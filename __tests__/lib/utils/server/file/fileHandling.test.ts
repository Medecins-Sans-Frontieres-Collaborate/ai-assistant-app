import {
  NoExtractableTextError,
  PdfExtractionError,
  countPdfPages,
  loadDocumentFromPath,
  looksLikeGarbledText,
} from '@/lib/utils/server/file/fileHandling';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
const readdirMock = vi.fn();
const readFileMock = vi.fn();
const mkdtempMock = vi.fn();
const rmMock = vi.fn();
const unlinkMock = vi.fn();
const writeFileMock = vi.fn();
const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (cmd: string, args: readonly string[], opts: unknown) =>
    spawnMock(cmd, args, opts),
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

const getDocumentMock = vi.fn();
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => getDocumentMock(...args),
}));

/** pdfjs stub: pages of the given texts (empty array = unreadable/scanned). */
function pdfjsPages(pageTexts: string[]) {
  getDocumentMock.mockReturnValue({
    promise: Promise.resolve({
      numPages: pageTexts.length,
      getPage: async (n: number) => ({
        getTextContent: async () => ({
          items: pageTexts[n - 1]
            ? pageTexts[n - 1].split(' ').map((str) => ({ str }))
            : [],
        }),
      }),
    }),
  });
}

function pdfjsThrows(message: string) {
  getDocumentMock.mockReturnValue({
    promise: Promise.reject(new Error(message)),
  });
}

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

beforeEach(() => {
  getDocumentMock.mockReset();
  execFileMock.mockReset();
  spawnMock.mockReset();
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

describe('pdfToText chain via loadDocumentFromPath', () => {
  const PDF = Buffer.from('%PDF-1.4 stub');
  const calls = (cmd: string) =>
    execFileMock.mock.calls.filter(([c]) => c === cmd);

  beforeEach(() => {
    readFileMock.mockResolvedValue(PDF);
  });

  it('returns pdfjs text without touching the CLI tools', async () => {
    pdfjsPages(['Hello world from page one']);
    const out = await loadDocumentFromPath(
      '/input/a.pdf',
      'application/pdf',
      'a.pdf',
    );
    expect(out).toContain('Hello world from page one');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a well-formed scan (pdfjs + pdftotext empty) → NoExtractableTextError, no Ghostscript', async () => {
    pdfjsPages(['']);
    execFileMock.mockResolvedValue({ stdout: '  \n', stderr: '' });
    await expect(
      loadDocumentFromPath('/input/scan.pdf', 'application/pdf', 'scan.pdf'),
    ).rejects.toBeInstanceOf(NoExtractableTextError);
    expect(calls('pdftotext')).toHaveLength(1);
    expect(calls('gs')).toHaveLength(0);
  });

  it('treats glyph-id gibberish as no text rather than indexing it', async () => {
    pdfjsPages([
      '\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u000e\u000f'.repeat(6),
    ]);
    execFileMock.mockResolvedValue({
      stdout:
        '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD'.repeat(
          6,
        ),
      stderr: '',
    });
    await expect(
      loadDocumentFromPath('/input/g.pdf', 'application/pdf', 'g.pdf'),
    ).rejects.toBeInstanceOf(NoExtractableTextError);
  });

  it('repairs with Ghostscript when both extractors threw, then reads the repaired file', async () => {
    pdfjsThrows('Invalid XRef stream header');
    let repairedPath = '';
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd === 'pdftotext' && args[0] === '/input/broken.pdf') {
        return Promise.reject(
          new Error("Syntax Error: Couldn't read xref table"),
        );
      }
      if (cmd === 'gs') {
        repairedPath = args[1];
        expect(args).toEqual(
          expect.arrayContaining([
            '-o',
            '-sDEVICE=pdfwrite',
            '/input/broken.pdf',
          ]),
        );
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'pdftotext' && args[0] === repairedPath) {
        return Promise.resolve({
          stdout: 'Recovered paragraph of perfectly readable prose.',
          stderr: '',
        });
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const out = await loadDocumentFromPath(
      '/input/broken.pdf',
      'application/pdf',
      'broken.pdf',
    );
    expect(out).toBe('Recovered paragraph of perfectly readable prose.');
    expect(calls('gs')).toHaveLength(1);
    expect(unlinkMock).toHaveBeenCalledWith(repairedPath);
  });

  it('names every cause when pdfjs, pdftotext and Ghostscript all fail', async () => {
    pdfjsThrows('password required');
    execFileMock.mockImplementation((cmd: string) =>
      Promise.reject(
        new Error(cmd === 'gs' ? 'gs exited 1' : 'Incorrect password'),
      ),
    );
    const promise = loadDocumentFromPath(
      '/input/enc.pdf',
      'application/pdf',
      'enc.pdf',
    );
    await expect(promise).rejects.toBeInstanceOf(PdfExtractionError);
    await expect(promise).rejects.toThrow(
      /pdfjs: password required; pdftotext: Incorrect password; ghostscript: gs exited 1/,
    );
  });

  it('forwards the AbortSignal to Ghostscript too', async () => {
    const controller = new AbortController();
    pdfjsThrows('boom');
    execFileMock.mockImplementation(
      (cmd: string, _args: readonly string[], opts: { signal?: unknown }) => {
        expect(opts.signal).toBe(controller.signal);
        return cmd === 'gs'
          ? Promise.resolve({ stdout: '', stderr: '' })
          : Promise.resolve({
              stdout: 'Readable text after everything',
              stderr: '',
            });
      },
    );
    await loadDocumentFromPath('/input/s.pdf', 'application/pdf', 's.pdf', {
      signal: controller.signal,
    });
  });
});

describe('looksLikeGarbledText', () => {
  it('passes prose, numeric tables, page markers and short strings', () => {
    expect(
      looksLikeGarbledText(
        'The quick brown fox jumps over the lazy dog, twice.',
      ),
    ).toBe(false);
    expect(
      looksLikeGarbledText(
        '2024  1,234.50  5,678.00  -12.5%\n2025  2,345.75  6,789.10  +3.2%',
      ),
    ).toBe(false);
    expect(
      looksLikeGarbledText(
        '--- Page 1 ---\nBudget (EUR) — Q1/Q2; totals: 100%',
      ),
    ).toBe(false);
    expect(looksLikeGarbledText('\u0001\u0002')).toBe(false);
    expect(
      looksLikeGarbledText('Straße — naïve café, 東京, Москва: fine text!'),
    ).toBe(false);
  });

  it('flags control-character glyph dumps and replacement-character soup', () => {
    expect(
      looksLikeGarbledText('\u0001\u0002\u0003\u0004\u0005'.repeat(10)),
    ).toBe(true);
    expect(looksLikeGarbledText('ab\uFFFDcd\uFFFDef\uFFFD'.repeat(6))).toBe(
      true,
    );
  });
});

/** Minimal ChildProcess stand-in: emits the given stdout, then closes. */
function fakeChild(stdout: string, code = 0, stderr = '') {
  const { EventEmitter } = require('events') as typeof import('events');
  const child = new EventEmitter() as import('events').EventEmitter & {
    stdout: import('events').EventEmitter;
    stderr: import('events').EventEmitter;
    stdin: { on: () => void; end: (input: Buffer) => void; written?: Buffer };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.stdin = {
    on: () => undefined,
    end: (input: Buffer) => {
      child.stdin.written = input;
      setImmediate(() => {
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      });
    },
  };
  return child;
}

describe('countPdfPages', () => {
  it('uses pdfjs when it can open the file', async () => {
    pdfjsPages(['a', 'b', 'c']);
    await expect(countPdfPages(Buffer.from('%PDF'))).resolves.toBe(3);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('falls back to pdfinfo over stdin — the network bytes never touch the filesystem', async () => {
    pdfjsThrows('bad xref');
    const child = fakeChild('Title: x\nPages:          12\nEncrypted: no\n');
    spawnMock.mockReturnValue(child);
    const bytes = Buffer.from('%PDF-1.4 damaged');
    const controller = new AbortController();
    await expect(
      countPdfPages(bytes, { signal: controller.signal }),
    ).resolves.toBe(12);
    // The caller's abort reaches the child like every other converter.
    expect(spawnMock).toHaveBeenCalledWith(
      'pdfinfo',
      ['-'],
      expect.objectContaining({
        killSignal: 'SIGKILL',
        signal: controller.signal,
      }),
    );
    expect(child.stdin.written).toBe(bytes);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('surfaces a pdfinfo failure with its stderr', async () => {
    pdfjsThrows('bad xref');
    spawnMock.mockReturnValue(
      fakeChild('', 1, "Syntax Error: Couldn't find trailer dictionary"),
    );
    await expect(countPdfPages(Buffer.from('%PDF'))).rejects.toThrow(
      /pdfinfo exited with 1: Syntax Error/,
    );
  });
});
