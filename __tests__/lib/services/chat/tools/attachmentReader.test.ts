import {
  ATTACHMENT_READ_CHUNK_CHARS,
  ATTACHMENT_TURN_BUDGET_CHARS,
  createAttachmentReader,
} from '@/lib/services/chat/tools/attachmentReader';

import { describe, expect, it } from 'vitest';

const line = (i: number) =>
  `Ligne ${String(i).padStart(5, '0')} ${'x'.repeat(90)}`;
// ~100 chars per line, 1000 lines → ~100K chars (over four read chunks).
const report = Array.from({ length: 1000 }, (_, i) => line(i)).join('\n');
const framework =
  'D1 Accès\nI7 — Délai de prise en charge psychosociale\nCible : ≥ 70 %\nD2 Qualité';

function reader() {
  return createAttachmentReader({
    'Rapport_annuel_2023.pdf': report,
    'Cadre.docx': framework,
  })!;
}

const call = (name: string, args: Record<string, unknown>) =>
  reader().callTool(name, args);

describe('createAttachmentReader', () => {
  it('offers nothing when no file is partial', () => {
    expect(createAttachmentReader({})).toBeUndefined();
    expect(createAttachmentReader({ 'a.pdf': '' })).toBeUndefined();
  });

  it('is read-only and runs inside the request', async () => {
    const tools = await reader().listTools();
    expect(reader().immediate).toBe(true);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'read_attachment',
      'search_attachment',
    ]);
    // The model can only name files it was given.
    expect((tools[0].inputSchema.properties as any).filename.enum).toEqual([
      'Rapport_annuel_2023.pdf',
      'Cadre.docx',
    ]);
  });

  it('reads one chunk, cut at a line break, and says where to continue', async () => {
    const { resultText, isError } = await call('read_attachment', {
      filename: 'rapport_annuel_2023.pdf',
    });
    expect(isError).toBe(false);
    const [header, , ...body] = resultText.split('\n');
    const end = Number(/start=(\d+)/.exec(header)![1]);
    expect(end).toBeLessThanOrEqual(ATTACHMENT_READ_CHUNK_CHARS);
    expect(report[end - 1]).toBe('\n');
    expect(body.join('\n')).toBe(report.slice(0, end));
  });

  it('continues from an offset and marks the end of the file', async () => {
    const start = report.length - 250;
    const { resultText } = await call('read_attachment', {
      filename: 'Rapport_annuel_2023.pdf',
      start,
    });
    expect(resultText).toContain('end of file');
    expect(resultText.endsWith(report.slice(start))).toBe(true);
  });

  it('stops serving text once the turn budget is spent', async () => {
    const r = reader();
    let start = 0;
    let served = 0;
    for (let i = 0; i < 10; i++) {
      const { resultText, isError } = await r.callTool('read_attachment', {
        filename: 'Rapport_annuel_2023.pdf',
        start,
      });
      if (isError) {
        expect(resultText).toContain('budget');
        break;
      }
      served += resultText.length;
      start = Number(/start=(\d+)/.exec(resultText)?.[1] ?? 0);
      if (!start) start = 0;
    }
    // One file of ~100K chars fits; repeated reads beyond the budget do not.
    expect(served).toBeLessThanOrEqual(ATTACHMENT_TURN_BUDGET_CHARS + 2_000);
  });

  it('finds a phrase ignoring case and accents, with a usable offset', async () => {
    const { resultText } = await call('search_attachment', {
      filename: 'Cadre.docx',
      query: 'delai de PRISE en charge',
    });
    expect(resultText).toContain('1 passage');
    expect(resultText).toContain(
      '> I7 — Délai de prise en charge psychosociale',
    );
    const offset = Number(/@(\d+):/.exec(resultText)![1]);
    expect(framework.slice(offset).startsWith('I7')).toBe(true);
  });

  it('falls back to lines carrying every term when the phrase is absent', async () => {
    const { resultText } = await call('search_attachment', {
      filename: 'Cadre.docx',
      query: 'psychosociale I7',
    });
    expect(resultText).toContain('1 passage');
  });

  it('says so when nothing matches, and rejects unknown files', async () => {
    expect(
      (
        await call('search_attachment', {
          filename: 'Cadre.docx',
          query: 'budget',
        })
      ).resultText,
    ).toContain('No passage');
    const unknown = await call('read_attachment', { filename: 'other.pdf' });
    expect(unknown.isError).toBe(true);
    expect(unknown.resultText).toContain('Cadre.docx');
  });

  it('never sends document text to the browser record', async () => {
    const r = reader();
    const args = { filename: 'Cadre.docx' };
    const result = await r.callTool('read_attachment', args);
    const record = r.recordOutput!('read_attachment', args, result);
    expect(record).not.toContain('Délai');
    expect(record).toContain('Cadre.docx');
  });
});
