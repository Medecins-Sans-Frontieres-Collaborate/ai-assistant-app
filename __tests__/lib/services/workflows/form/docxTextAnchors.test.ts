import {
  detectDocxTextSlots,
  fillDocxDocument,
  findElements,
  normalizeLabel,
} from '@/lib/services/workflows/form/docxTextAnchors';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function p(text: string, rPr = ''): string {
  return text === ''
    ? '<w:p><w:pPr><w:jc w:val="left"/></w:pPr></w:p>'
    : `<w:p><w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}
function tc(inner: string): string {
  return `<w:tc><w:tcPr><w:tcW w:w="4000"/></w:tcPr>${inner}</w:tc>`;
}
function docx(body: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
    ),
  });
}
const xmlOf = (bytes: Uint8Array) =>
  strFromU8(unzipSync(bytes)['word/document.xml']);

const table = `<w:tbl><w:tr>${tc(p('Applicant name'))}${tc(p(''))}</w:tr><w:tr>${tc(p('Summary of the project'))}${tc(p(''))}</w:tr><w:tr>${tc(p('Signature'))}${tc(p('already here'))}</w:tr></w:tbl>`;
const body = `${p('Grant application form')}${p('Date:')}${p('Budget: ______')}${p('Objectives')}${p('')}${p('This is a long paragraph of prose that explains what the applicant should write in the section below and is not a label at all.')}${p('')}${table}${p('Contact person')}${p('')}`;

describe('findElements', () => {
  it('handles nesting and treats self-closing paragraphs as empty elements', () => {
    const xml = '<w:tc><w:p/><w:p><w:r/></w:p></w:tc><w:tc></w:tc>';
    expect(findElements(xml, 'tc')).toHaveLength(2);
    expect(findElements(xml, 'p')).toHaveLength(2);
  });
});

describe('normalizeLabel', () => {
  it('strips trailing colons and blanks', () => {
    expect(normalizeLabel('Budget: ______')).toBe('Budget');
    expect(normalizeLabel('  Date：')).toBe('Date');
  });
});

describe('detectDocxTextSlots', () => {
  it('finds label slots with the right placement and skips prose', () => {
    const slots = detectDocxTextSlots(docx(body));
    expect(slots.map((s) => [s.labelText, s.placement])).toEqual([
      ['Date', 'after-label'],
      ['Budget', 'after-label'],
      ['Objectives', 'next-paragraph'],
      ['Applicant name', 'table-cell-right'],
      ['Summary of the project', 'table-cell-right'],
      ['Contact person', 'next-paragraph'],
    ]);
    expect(slots.every((s) => s.occurrence === 0)).toBe(true);
  });

  it('numbers repeated labels', () => {
    const slots = detectDocxTextSlots(docx(`${p('Name:')}${p('Name:')}`));
    expect(slots.map((s) => s.occurrence)).toEqual([0, 1]);
  });

  it("sees Word's attribute-only empty paragraphs as next-paragraph targets", () => {
    const slots = detectDocxTextSlots(
      docx(`${p('Objectives')}<w:p w:rsidR="00AB12"/>${p('Later')}`),
    );
    expect(slots.map((s) => [s.labelText, s.placement])).toEqual([
      ['Objectives', 'next-paragraph'],
    ]);
  });
});

describe('fillDocxDocument', () => {
  it('writes into cells, after labels, and next paragraphs; reports misses', () => {
    const result = fillDocxDocument(docx(body), {}, [
      {
        labelText: 'Applicant name',
        occurrence: 0,
        placement: 'table-cell-right',
        value: 'Amina',
      },
      {
        labelText: 'Budget',
        occurrence: 0,
        placement: 'after-label',
        value: '12,000 EUR',
      },
      {
        labelText: 'Objectives',
        occurrence: 0,
        placement: 'next-paragraph',
        value: 'One\nTwo',
      },
      {
        labelText: 'Nope',
        occurrence: 0,
        placement: 'after-label',
        value: 'x',
      },
    ]);
    expect(result.filled.sort()).toEqual([
      'Applicant name#0',
      'Budget#0',
      'Objectives#0',
    ]);
    expect(result.missing).toEqual(['Nope#0']);
    const xml = xmlOf(result.bytes);
    // Cell: tcPr kept, one paragraph with the value.
    expect(xml).toMatch(
      /<w:tc><w:tcPr><w:tcW w:w="4000"\/><\/w:tcPr><w:p><w:pPr><w:jc w:val="left"\/><\/w:pPr><w:r><w:t xml:space="preserve">Amina<\/w:t><\/w:r><\/w:p><\/w:tc>/,
    );
    // After-label: blank line dropped, value appended after a space.
    expect(xml).not.toContain('______');
    expect(xml).toMatch(
      /Budget:<\/w:t><\/w:r><w:r><w:t xml:space="preserve"> <\/w:t><\/w:r><w:r><w:t xml:space="preserve">12,000 EUR<\/w:t>/,
    );
    // Next paragraph: two paragraphs with the empty paragraph's pPr.
    expect(
      xml.match(/<w:t xml:space="preserve">(One|Two)<\/w:t>/g),
    ).toHaveLength(2);
    expect(strFromU8(unzipSync(result.bytes)['[Content_Types].xml'])).toBe(
      '<Types/>',
    );
  });

  it('fills every occurrence of a repeated label, in any order', () => {
    const bytes = docx(
      `${p('Name:')}${p('Name:')}<w:tbl><w:tr>${tc(p('Site'))}${tc(p(''))}</w:tr><w:tr>${tc(p('Site'))}${tc(p(''))}</w:tr></w:tbl>`,
    );
    const result = fillDocxDocument(bytes, {}, [
      {
        labelText: 'Name',
        occurrence: 1,
        placement: 'after-label',
        value: 'second',
      },
      {
        labelText: 'Name',
        occurrence: 0,
        placement: 'after-label',
        value: 'first',
      },
      {
        labelText: 'Site',
        occurrence: 0,
        placement: 'table-cell-right',
        value: 'Goma',
      },
      {
        labelText: 'Site',
        occurrence: 1,
        placement: 'table-cell-right',
        value: 'Bukavu',
      },
    ]);
    expect(result.missing).toEqual([]);
    const xml = xmlOf(result.bytes);
    expect(xml.indexOf('first')).toBeLessThan(xml.indexOf('second'));
    expect(xml.indexOf('Goma')).toBeLessThan(xml.indexOf('Bukavu'));
  });

  it('writes into an attribute-only empty paragraph', () => {
    const result = fillDocxDocument(
      docx(`${p('Objectives')}<w:p w:rsidR="00AB12"/>`),
      {},
      [
        {
          labelText: 'Objectives',
          occurrence: 0,
          placement: 'next-paragraph',
          value: 'Done',
        },
      ],
    );
    expect(result.missing).toEqual([]);
    expect(xmlOf(result.bytes)).toContain('>Done</w:t>');
    expect(xmlOf(result.bytes)).not.toContain('w:rsidR="00AB12"/>');
  });

  it('combines controls and text anchors in one pass', () => {
    const control =
      '<w:sdt><w:sdtPr><w:tag w:val="ref"/></w:sdtPr><w:sdtContent><w:r><w:t>x</w:t></w:r></w:sdtContent></w:sdt>';
    const result = fillDocxDocument(
      docx(`<w:p>${control}</w:p>${p('Date:')}`),
      { ref: 'R-1' },
      [
        {
          labelText: 'Date',
          occurrence: 0,
          placement: 'after-label',
          value: '2026-01-01',
        },
      ],
    );
    expect(result.filled.sort()).toEqual(['Date#0', 'ref']);
    const xml = xmlOf(result.bytes);
    expect(xml).toContain('R-1');
    expect(xml).toContain('2026-01-01');
  });
});
