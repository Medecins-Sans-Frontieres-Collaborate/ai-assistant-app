import {
  detectDocxControls,
  fillDocxControls,
  isDocx,
} from '@/lib/services/workflows/form/docxFill';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';

function sdt(pr: string, content: string): string {
  return `<w:sdt><w:sdtPr>${pr}</w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`;
}

const inlineText = sdt(
  '<w:alias w:val="Applicant name"/><w:tag w:val="applicant_name"/><w:showingPlcHdr/>',
  '<w:r><w:rPr><w:rStyle w:val="PlaceholderText"/><w:b/></w:rPr><w:t>Click here to enter text.</w:t></w:r>',
);
const blockText = sdt(
  '<w:alias w:val="Summary"/><w:tag w:val="summary"/>',
  '<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>Placeholder</w:t></w:r></w:p>',
);
const checkbox = sdt(
  '<w:tag w:val="agree"/><w14:checkbox><w14:checked w14:val="0"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox>',
  '<w:r><w:rPr><w:rFonts w:ascii="MS Gothic"/></w:rPr><w:t>☐</w:t></w:r>',
);
const dropdown = sdt(
  '<w:alias w:val="Region"/><w:dropDownList><w:listItem w:displayText="North" w:value="N"/><w:listItem w:displayText="South" w:value="S"/></w:dropDownList>',
  '<w:r><w:t>Choose an item.</w:t></w:r>',
);
const group = `<w:sdt><w:sdtPr><w:tag w:val="group"/><w:group/></w:sdtPr><w:sdtContent><w:p>${inlineText}</w:p></w:sdtContent></w:sdt>`;
const untagged = sdt('<w:id w:val="1"/>', '<w:r><w:t>anonymous</w:t></w:r>');

function docx(body: string, header?: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
    ),
  };
  if (header) {
    files['word/header1.xml'] = strToU8(
      `<w:hdr ${NS}><w:p>${header}</w:p></w:hdr>`,
    );
  }
  return zipSync(files);
}

function documentXml(bytes: Uint8Array): string {
  return strFromU8(unzipSync(bytes)['word/document.xml']);
}

describe('detectDocxControls', () => {
  it('finds tagged/aliased controls with kinds, skips groups and untagged ones', () => {
    const bytes = docx(
      `<w:p>${group}</w:p>${blockText}<w:p>${checkbox}${dropdown}${untagged}</w:p>`,
      sdt('<w:tag w:val="applicant_name"/>', '<w:r><w:t>x</w:t></w:r>'),
    );
    expect(isDocx(bytes)).toBe(true);
    const controls = detectDocxControls(bytes);
    expect(controls.map((c) => [c.key, c.kind, c.part])).toEqual([
      ['applicant_name', 'text', 'word/document.xml'],
      ['summary', 'text', 'word/document.xml'],
      ['agree', 'checkbox', 'word/document.xml'],
      ['Region', 'dropdown', 'word/document.xml'],
      ['applicant_name', 'text', 'word/header1.xml'],
    ]);
    expect(controls[0]).toMatchObject({
      alias: 'Applicant name',
      text: 'Click here to enter text.',
    });
    expect(controls[3].options).toEqual(['North', 'South']);
  });
});

describe('fillDocxControls', () => {
  it('writes text into every occurrence, keeps run/paragraph properties, drops placeholder styling', () => {
    const bytes = docx(
      `<w:p>${group}</w:p>${blockText}`,
      sdt('<w:tag w:val="applicant_name"/>', '<w:r><w:t>x</w:t></w:r>'),
    );
    const result = fillDocxControls(bytes, {
      applicant_name: 'Amina & Co <MSF>',
      summary: 'Line one\nLine two',
      ghost: 'nowhere',
    });
    expect(result.filled.sort()).toEqual(['applicant_name', 'summary']);
    expect(result.missing).toEqual(['ghost']);
    const xml = documentXml(result.bytes);
    expect(xml).toContain(
      '<w:t xml:space="preserve">Amina &amp; Co &lt;MSF&gt;</w:t>',
    );
    expect(xml).toContain('<w:rPr><w:b/></w:rPr>');
    expect(xml).not.toContain('PlaceholderText');
    expect(xml).not.toContain('showingPlcHdr');
    expect(xml).not.toContain('Click here to enter text.');
    // Block control: two paragraphs, each with the original pPr and rPr.
    const paragraphs = xml.match(
      /<w:p><w:pPr><w:jc w:val="both"\/><\/w:pPr><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">Line (one|two)<\/w:t><\/w:r><\/w:p>/g,
    );
    expect(paragraphs).toHaveLength(2);
    // Header occurrence filled too.
    const header = strFromU8(unzipSync(result.bytes)['word/header1.xml']);
    expect(header).toContain('Amina &amp; Co');
    // Untouched parts survive byte-for-byte.
    expect(strFromU8(unzipSync(result.bytes)['[Content_Types].xml'])).toBe(
      '<Types/>',
    );
  });

  it('checks boxes and resolves dropdown display text', () => {
    const bytes = docx(`<w:p>${checkbox}${dropdown}</w:p>`);
    const result = fillDocxControls(bytes, { agree: true, Region: 's' });
    const xml = documentXml(result.bytes);
    expect(xml).toContain('<w14:checked w14:val="1"/>');
    expect(xml).toContain('<w:t>☒</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">South</w:t>');
    const off = documentXml(fillDocxControls(bytes, { agree: 'no' }).bytes);
    expect(off).toContain('<w14:checked w14:val="0"/>');
    expect(off).toContain('<w:t>☐</w:t>');
  });

  it('fills controls whose keys collided under the old hash, and ignores prototype names', () => {
    const bytes = docx(
      `<w:p>${sdt('<w:tag w:val="Aa"/>', '<w:r><w:t>x</w:t></w:r>')}${sdt('<w:tag w:val="BB"/>', '<w:r><w:t>y</w:t></w:r>')}${sdt('<w:tag w:val="constructor"/>', '<w:r><w:t>z</w:t></w:r>')}</w:p>`,
    );
    const result = fillDocxControls(bytes, { Aa: 'one', BB: 'two' });
    expect(result.filled.sort()).toEqual(['Aa', 'BB']);
    const xml = documentXml(result.bytes);
    expect(xml).toContain('>one</w:t>');
    expect(xml).toContain('>two</w:t>');
    expect(xml).toContain('>z</w:t>');
  });

  it('strips control characters that would corrupt the XML', () => {
    const bytes = docx(inlineText);
    const xml = documentXml(
      fillDocxControls(bytes, { applicant_name: 'a\u0000b\u0007c' }).bytes,
    );
    expect(xml).toContain('>abc</w:t>');
  });
});
