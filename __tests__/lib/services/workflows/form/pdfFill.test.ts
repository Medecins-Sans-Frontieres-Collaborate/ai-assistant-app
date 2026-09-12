import {
  detectPdfFields,
  fillPdfFields,
  isPdf,
} from '@/lib/services/workflows/form/pdfFill';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  const name = form.createTextField('applicant.name');
  name.addToPage(page, { x: 20, y: 340, width: 200, height: 24 });
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(page, { x: 20, y: 200, width: 300, height: 100 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 20, y: 160, width: 16, height: 16 });
  const region = form.createRadioGroup('region');
  region.addOptionToPage('North', page, {
    x: 20,
    y: 120,
    width: 16,
    height: 16,
  });
  region.addOptionToPage('South', page, {
    x: 60,
    y: 120,
    width: 16,
    height: 16,
  });
  const kind = form.createDropdown('kind');
  kind.addOptions(['Grant', 'Loan']);
  kind.addToPage(page, { x: 20, y: 80, width: 120, height: 20 });
  return doc.save();
}

describe('pdf AcroForm', () => {
  it('detects fields with kinds and options', async () => {
    const bytes = await samplePdf();
    expect(isPdf(bytes)).toBe(true);
    const fields = await detectPdfFields(bytes);
    expect(fields).toEqual([
      {
        name: 'applicant.name',
        kind: 'text',
        multiline: false,
        value: undefined,
      },
      { name: 'notes', kind: 'text', multiline: true, value: undefined },
      { name: 'agree', kind: 'checkbox', value: undefined },
      {
        name: 'region',
        kind: 'radio',
        options: ['North', 'South'],
        value: undefined,
      },
      {
        name: 'kind',
        kind: 'dropdown',
        options: ['Grant', 'Loan'],
        value: undefined,
      },
    ]);
  });

  it('fills by name and reports missing, failed and unmatched options', async () => {
    const bytes = await samplePdf();
    const result = await fillPdfFields(bytes, {
      'applicant.name': 'Amina',
      notes: 'Line 1\nLine 2',
      agree: true,
      region: 'south',
      kind: 'Bond',
      ghost: 'x',
    });
    expect(result.filled.sort()).toEqual([
      'agree',
      'applicant.name',
      'notes',
      'region',
    ]);
    expect(result.missing).toEqual(['ghost']);
    expect(result.failed).toEqual([
      { name: 'kind', reason: 'No matching option' },
    ]);

    const filled = await detectPdfFields(result.bytes);
    const byName = Object.fromEntries(filled.map((f) => [f.name, f]));
    expect(byName['applicant.name'].value).toBe('Amina');
    expect(byName.notes.value).toBe('Line 1\nLine 2');
    expect(byName.agree.value).toBe('true');
    expect(byName.region.value).toBe('South');
  });

  it('reports a glyph the standard font cannot render instead of throwing', async () => {
    const bytes = await samplePdf();
    const result = await fillPdfFields(bytes, { 'applicant.name': 'أمينة' });
    expect(result.filled).toEqual([]);
    expect(result.failed[0].name).toBe('applicant.name');
  });

  it('flattens on request without losing values', async () => {
    const bytes = await samplePdf();
    const result = await fillPdfFields(
      bytes,
      { 'applicant.name': 'Amina' },
      { flatten: true },
    );
    expect(result.filled).toEqual(['applicant.name']);
    expect(await detectPdfFields(result.bytes)).toEqual([]);
  });
});
