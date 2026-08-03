import { rewriteSandboxLinks } from '@/lib/utils/shared/chat/sandboxLinks';

import type { GeneratedFileRef } from '@/lib/streamMarkers';
import { describe, expect, it } from 'vitest';

const xlsxFile: GeneratedFileRef = {
  url: '/api/file/abc123.xlsx',
  filename: 'dummy_yearly_medical_exam_data.xlsx',
  mime_type:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  is_image: false,
};

const chartFile: GeneratedFileRef = {
  url: '/api/file/def456.png',
  filename: 'chart.png',
  mime_type: 'image/png',
  is_image: true,
};

describe('rewriteSandboxLinks', () => {
  it('returns content without sandbox links untouched', () => {
    const content = 'Regular text with a [real link](https://example.com).';
    expect(rewriteSandboxLinks(content)).toBe(content);
  });

  it('degrades an unmatched sandbox link to its plain label', () => {
    const content =
      '[Download the Excel file](sandbox:/mnt/data/dummy_yearly_medical_exam_data.xlsx)';
    expect(rewriteSandboxLinks(content)).toBe('Download the Excel file');
  });

  it('re-points a sandbox link at the matching generated file URL', () => {
    const content =
      'Here: [Download the Excel file](sandbox:/mnt/data/dummy_yearly_medical_exam_data.xlsx).';
    expect(rewriteSandboxLinks(content, [xlsxFile])).toBe(
      'Here: [Download the Excel file](/api/file/abc123.xlsx).',
    );
  });

  it('matches filenames case-insensitively', () => {
    const content =
      '[Download](sandbox:/mnt/data/DUMMY_YEARLY_MEDICAL_EXAM_DATA.XLSX)';
    expect(rewriteSandboxLinks(content, [xlsxFile])).toBe(
      '[Download](/api/file/abc123.xlsx)',
    );
  });

  it('drops sandbox image references entirely', () => {
    const content = 'Chart below:\n\n![The chart](sandbox:/mnt/data/chart.png)';
    expect(rewriteSandboxLinks(content, [chartFile])).toBe('Chart below:\n\n');
  });

  it('degrades a matched image file link to its label (images serve via base64, not URL)', () => {
    const content = '[View the chart](sandbox:/mnt/data/chart.png)';
    expect(rewriteSandboxLinks(content, [chartFile])).toBe('View the chart');
  });

  it('degrades autolinks to the bare filename', () => {
    const content = 'Saved to <sandbox:/mnt/data/report.pdf>.';
    expect(rewriteSandboxLinks(content)).toBe('Saved to report.pdf.');
  });

  it('handles link titles and angle-bracketed targets', () => {
    expect(
      rewriteSandboxLinks(
        '[Download](<sandbox:/mnt/data/dummy_yearly_medical_exam_data.xlsx> "the file")',
        [xlsxFile],
      ),
    ).toBe('[Download](/api/file/abc123.xlsx)');
  });

  it('decodes percent-encoded filenames before matching', () => {
    const file: GeneratedFileRef = {
      ...xlsxFile,
      filename: 'my report.xlsx',
    };
    expect(
      rewriteSandboxLinks('[Get it](sandbox:/mnt/data/my%20report.xlsx)', [
        file,
      ]),
    ).toBe('[Get it](/api/file/abc123.xlsx)');
  });

  it('rewrites multiple links in one message independently', () => {
    const content =
      '[A](sandbox:/mnt/data/dummy_yearly_medical_exam_data.xlsx) and [B](sandbox:/mnt/data/unknown.csv)';
    expect(rewriteSandboxLinks(content, [xlsxFile])).toBe(
      '[A](/api/file/abc123.xlsx) and B',
    );
  });

  it('leaves plain-text mentions of sandbox paths alone', () => {
    const content =
      'The file lives at sandbox:/mnt/data/report.pdf in the container.';
    expect(rewriteSandboxLinks(content)).toBe(content);
  });
});
