import { run } from '@/lib/services/grants/stages/extractText';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const diMock = vi.hoisted(() => ({ analyzeDocument: vi.fn() }));
vi.mock('@/lib/services/documentIntelligence/client', () => diMock);

const progress = {
  stageStart: vi.fn(),
  tick: vi.fn(),
  stageDone: vi.fn(),
};

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-extract-'));
  process.env.GRANT_PIPELINE_DI_ENDPOINT = 'https://grants-di.example.com';
  process.env.GRANT_PIPELINE_DI_KEY = 'grants-key';
  diMock.analyzeDocument.mockResolvedValue({
    content: 'Extracted body',
    pages: [{ pageNumber: 1, text: 'Extracted body' }],
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.GRANT_PIPELINE_DI_ENDPOINT;
  delete process.env.GRANT_PIPELINE_DI_KEY;
});

describe('grants extractText stage via the shared DI client', () => {
  it('analyses PDFs with prebuilt-layout using the grants overrides and writes the text file', async () => {
    const docPath = path.join(dir, 'proposal.pdf');
    fs.writeFileSync(docPath, '%PDF-1.4');
    const outDir = path.join(dir, 'out');
    const result = await run({ documents: [docPath], outDir, progress });
    expect(diMock.analyzeDocument).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({
        model: 'prebuilt-layout',
        contentType: 'application/pdf',
        endpoint: 'https://grants-di.example.com',
        key: 'grants-key',
      }),
    );
    const outPath = result['proposal.pdf'];
    expect(outPath).toBeDefined();
    expect(fs.readFileSync(outPath, 'utf-8')).toBe('Extracted body');
  });

  it('reads .txt directly without calling the service', async () => {
    const docPath = path.join(dir, 'notes.txt');
    fs.writeFileSync(docPath, 'plain');
    const result = await run({
      documents: [docPath],
      outDir: path.join(dir, 'out'),
      progress,
    });
    expect(diMock.analyzeDocument).not.toHaveBeenCalled();
    expect(fs.readFileSync(result['notes.txt'], 'utf-8')).toBe('plain');
  });
});
