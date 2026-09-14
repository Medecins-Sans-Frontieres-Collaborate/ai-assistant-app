/**
 * OCR engine selection for scanned PDFs (Prepare + auto-OCR): Document
 * Intelligence when configured, the vision model otherwise, page caps
 * forwarded to both.
 */
import {
  OcrEngineUnavailableError,
  ocrPdfBuffer,
  resolveOcrEngine,
} from '@/lib/services/m365/agentPreparationService';

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  env: {
    M365_AGENT_OCR_ENGINE: 'auto',
    M365_AGENT_VISION_MODEL: 'gpt-5-mini',
    M365_AGENT_OCR_MAX_PAGES: 200,
  } as Record<string, unknown>,
}));
const diMock = vi.hoisted(() => ({
  configured: true,
  analyzeDocument: vi.fn(),
}));
const mockVision = vi.hoisted(() => ({ create: vi.fn() }));
const execMock = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('@/config/environment', () => envMock);
vi.mock(
  '@/lib/services/documentIntelligence/client',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/documentIntelligence/client')
      >();
    return {
      ...actual,
      isDocumentIntelligenceConfigured: () => diMock.configured,
      analyzeDocument: diMock.analyzeDocument,
    };
  },
);
vi.mock('@/lib/services/ServiceContainer', () => ({
  ServiceContainer: {
    getInstance: () => ({
      getOpenAIClient: () => ({ chat: { completions: mockVision } }),
    }),
  },
}));
vi.mock('@/auth', () => ({ auth: vi.fn(), getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/m365/agentIndexService', () => ({
  downloadItemBytes: vi.fn(),
}));
vi.mock('@/lib/services/adminBlobStorage', () => ({
  getAdminBlobStorage: vi.fn(),
}));
vi.mock('child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    execMock.execFile(cmd, args, opts);
    // pdftoppm: render "-l N" pages as empty PNGs next to the prefix.
    const prefix = args[args.length - 1];
    const limit = Number(args[args.indexOf('-l') + 1]);
    const pages = Math.min(limit, 3);
    for (let i = 1; i <= pages; i++) {
      fs.writeFileSync(`${prefix}-${i}.png`, Buffer.from('png'));
    }
    cb(null, { stdout: '', stderr: '' });
  },
}));

const pdf = Buffer.from('%PDF-1.4 scanned');

beforeEach(() => {
  vi.clearAllMocks();
  envMock.env.M365_AGENT_OCR_ENGINE = 'auto';
  diMock.configured = true;
  diMock.analyzeDocument.mockResolvedValue({
    content: 'A\nB',
    pages: [
      { pageNumber: 1, text: 'A' },
      { pageNumber: 2, text: 'B' },
    ],
  });
  mockVision.create.mockImplementation(async () => ({
    choices: [{ message: { content: 'seen text' } }],
  }));
});

describe('resolveOcrEngine', () => {
  it('auto prefers DI when configured, vision otherwise', () => {
    expect(resolveOcrEngine()).toBe('di');
    diMock.configured = false;
    expect(resolveOcrEngine()).toBe('vision');
  });

  it('di without configuration is a loud OcrEngineUnavailableError', () => {
    envMock.env.M365_AGENT_OCR_ENGINE = 'di';
    diMock.configured = false;
    expect(() => resolveOcrEngine()).toThrow(OcrEngineUnavailableError);
  });

  it('vision forces the vision path even with DI configured', () => {
    envMock.env.M365_AGENT_OCR_ENGINE = 'vision';
    expect(resolveOcrEngine()).toBe('vision');
  });
});

describe('ocrPdfBuffer', () => {
  it('uses Document Intelligence with a 1-N page selection and page markers', async () => {
    const result = await ocrPdfBuffer(pdf, 'scan.pdf', { maxPages: 50 });
    expect(diMock.analyzeDocument).toHaveBeenCalledWith(
      pdf,
      expect.objectContaining({
        model: 'prebuilt-read',
        contentType: 'application/pdf',
        pages: '1-50',
      }),
    );
    expect(result).toEqual({
      engine: 'di',
      pages: 2,
      text: '--- Page 1 ---\nA\n--- Page 2 ---\nB',
    });
    expect(mockVision.create).not.toHaveBeenCalled();
  });

  it('retries without the page selection when the service rejects the range', async () => {
    const { DocumentIntelligenceError } = await vi.importActual<
      typeof import('@/lib/services/documentIntelligence/client')
    >('@/lib/services/documentIntelligence/client');
    diMock.analyzeDocument
      .mockRejectedValueOnce(
        new DocumentIntelligenceError('Invalid pages range', 'submit', 400),
      )
      .mockResolvedValueOnce({
        content: 'A',
        pages: [{ pageNumber: 1, text: 'A' }],
      });
    const result = await ocrPdfBuffer(pdf, 'scan.pdf', { maxPages: 5 });
    expect(diMock.analyzeDocument).toHaveBeenCalledTimes(2);
    expect(diMock.analyzeDocument.mock.calls[1][1]).not.toHaveProperty('pages');
    expect(result.pages).toBe(1);
  });

  it('never returns more pages than the cap even if the service does', async () => {
    diMock.analyzeDocument.mockResolvedValue({
      content: '',
      pages: [1, 2, 3, 4].map((n) => ({ pageNumber: n, text: `p${n}` })),
    });
    const result = await ocrPdfBuffer(pdf, 'scan.pdf', { maxPages: 2 });
    expect(result.pages).toBe(2);
    expect(result.text).not.toContain('p3');
  });

  it('auto falls back to the vision model when DI errors', async () => {
    const { DocumentIntelligenceError } = await vi.importActual<
      typeof import('@/lib/services/documentIntelligence/client')
    >('@/lib/services/documentIntelligence/client');
    diMock.analyzeDocument.mockRejectedValue(
      new DocumentIntelligenceError('boom', 'poll', 500),
    );
    const result = await ocrPdfBuffer(pdf, 'scan.pdf', { maxPages: 2 });
    expect(result.engine).toBe('vision');
    expect(result.pages).toBe(2);
    expect(result.text).toBe(
      '--- Page 1 ---\nseen text\n--- Page 2 ---\nseen text',
    );
    // pdftoppm rendered only the capped page count.
    const args = execMock.execFile.mock.calls[0][1] as string[];
    expect(args[args.indexOf('-l') + 1]).toBe('2');
    expect(path.basename(args[args.length - 1])).toBe('page');
  });

  it('explicit di does not fall back', async () => {
    envMock.env.M365_AGENT_OCR_ENGINE = 'di';
    diMock.analyzeDocument.mockRejectedValue(new Error('boom'));
    await expect(
      ocrPdfBuffer(pdf, 'scan.pdf', { maxPages: 2 }),
    ).rejects.toThrow('boom');
    expect(mockVision.create).not.toHaveBeenCalled();
  });

  it('vision path forwards the abort signal to the render step', async () => {
    envMock.env.M365_AGENT_OCR_ENGINE = 'vision';
    const controller = new AbortController();
    await ocrPdfBuffer(pdf, 'scan.pdf', {
      maxPages: 1,
      signal: controller.signal,
    });
    const opts = execMock.execFile.mock.calls[0][2] as { signal?: AbortSignal };
    expect(opts.signal).toBe(controller.signal);
    expect(mockVision.create.mock.calls[0][1]).toEqual({
      signal: controller.signal,
    });
  });
});
