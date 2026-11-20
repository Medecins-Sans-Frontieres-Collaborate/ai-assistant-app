import { BrandFinding } from '@/lib/utils/shared/brand/brandFindings';
import {
  buildBrandReport,
  describeFinding,
} from '@/lib/utils/shared/brand/brandReport';

import { describe, expect, it } from 'vitest';

/** The words of a review and the report, with a translator that shows its inputs. */

const t = (key: string, values?: Record<string, string | number>) =>
  values
    ? `${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join(';')})`
    : key;

function finding(changes: Partial<BrandFinding>): BrandFinding {
  return {
    id: 'f',
    rule: 'font',
    severity: 'error',
    page: 1,
    unitId: 'u1',
    imageId: null,
    box: null,
    found: 'Comic Sans MS',
    expected: ['Montserrat'],
    source: 'check',
    ...changes,
  };
}

describe('describeFinding', () => {
  it('builds a check’s message from its values', () => {
    expect(describeFinding(finding({}), t)).toBe(
      'message.font(found=Comic Sans MS;expected=Montserrat;first=Montserrat;name=;count=1)',
    );
  });

  it('uses the message without alternatives when there are none', () => {
    expect(
      describeFinding(
        finding({ rule: 'banned-term', found: 'cheap', expected: [] }),
        t,
      ),
    ).toMatch(/^message\.banned-term-alone\(/);
  });

  it('gives a model finding in its own words', () => {
    expect(
      describeFinding(
        finding({ rule: 'tone', source: 'model', note: 'Warmer.' }),
        t,
      ),
    ).toBe('Warmer.');
  });
});

describe('buildBrandReport', () => {
  const base = {
    documentName: 'Review <draft>.pdf',
    bookName: 'North & wind',
    date: '20 Nov 2026',
    locale: 'en',
    pageCount: 2,
    skippedPages: [],
    partial: false,
  };

  it('escapes everything from the document, book and model', () => {
    const html = buildBrandReport(
      {
        ...base,
        findings: [
          finding({
            rule: 'tone',
            source: 'model',
            note: '<script>alert(1)</script>',
          }),
        ],
      },
      t,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Review &lt;draft&gt;.pdf');
    expect(html).toContain('North &amp; wind');
  });

  it('shows colours as swatches, only for colour values', () => {
    const html = buildBrandReport(
      {
        ...base,
        findings: [
          finding({ rule: 'color', found: '#ff00ff', expected: ['#0f7c80'] }),
          finding({ id: 'g', found: '#notacolour', expected: [] }),
        ],
      },
      t,
    );
    expect(html).toContain('style="background:#ff00ff"');
    expect(html).toContain('style="background:#0f7c80"');
    expect(html.match(/class="swatch"/g)).toHaveLength(2);
  });

  it('says when it is partial, which pages were not looked at, and when nothing was found', () => {
    const html = buildBrandReport(
      { ...base, findings: [], partial: true, skippedPages: [3, 4] },
      t,
    );
    expect(html).toContain('report.partial');
    expect(html).toContain('report.skipped(pages=3, 4)');
    expect(html).toContain('report.none');
    expect(html).not.toContain('<table>');
  });
});
