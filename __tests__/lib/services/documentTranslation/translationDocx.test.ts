import {
  buildTranslationHtml,
  renderTranslationDocx,
} from '@/lib/services/documentTranslation/translationDocx';

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const OPTIONS = {
  title: 'guide_es.docx',
  language: 'es',
  direction: 'ltr',
} as const;

function commandExists(command: string, versionFlag: string): boolean {
  try {
    execFileSync(command, [versionFlag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const canRender =
  commandExists('pandoc', '--version') && commandExists('unzip', '-v');

/** Reads word/document.xml out of a rendered DOCX. */
function documentXml(docx: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-test-'));
  try {
    const file = path.join(dir, 'out.docx');
    fs.writeFileSync(file, docx);
    return execFileSync('unzip', ['-p', file, 'word/document.xml']).toString();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildTranslationHtml', () => {
  it('turns blank-line separated text into paragraphs and joins wrapped lines', () => {
    const html = buildTranslationHtml(
      [{ page: 1, text: 'Primera línea\nsigue aquí.\n\nSegundo párrafo.' }],
      OPTIONS,
    );
    expect(html).toContain('<p>Primera línea sigue aquí.</p>');
    expect(html).toContain('<p>Segundo párrafo.</p>');
  });

  it('escapes page text so it cannot become markup', () => {
    const html = buildTranslationHtml(
      [{ page: 1, text: 'Hb < 7 g/dl & <script>alert("x")</script>' }],
      OPTIONS,
    );
    expect(html).toContain(
      'Hb &lt; 7 g/dl &amp; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(html).not.toContain('<script>');
  });

  it('separates pages with one break each, including around an empty page', () => {
    const html = buildTranslationHtml(
      [
        { page: 1, text: 'uno' },
        { page: 2, text: '' },
        { page: 3, text: 'tres' },
      ],
      OPTIONS,
    );
    expect(html.match(/class="page-break"/g)).toHaveLength(2);
  });

  it('declares language and direction on the document', () => {
    const html = buildTranslationHtml([{ page: 1, text: 'نص' }], {
      title: 't',
      language: 'ar',
      direction: 'rtl',
    });
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });
});

describe.skipIf(!canRender)('renderTranslationDocx (pandoc)', () => {
  it('writes the text and one page break between each pair of pages', async () => {
    const docx = await renderTranslationDocx(
      [
        { page: 1, text: 'Página uno' },
        { page: 2, text: 'Página dos' },
        { page: 3, text: 'Página tres' },
      ],
      OPTIONS,
    );
    const xml = documentXml(docx);
    expect(xml).toContain('Página dos');
    expect(xml.match(/w:br w:type="page"/g)).toHaveLength(2);
    expect(xml).not.toContain('<w:bidi');
  });

  it('marks paragraphs right-to-left for a right-to-left language', async () => {
    const docx = await renderTranslationDocx([{ page: 1, text: 'نص عربي' }], {
      title: 't',
      language: 'ar',
      direction: 'rtl',
    });
    expect(documentXml(docx)).toContain('<w:bidi');
  });
});
