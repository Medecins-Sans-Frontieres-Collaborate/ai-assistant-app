import {
  decodeBody,
  extractReadableContent,
} from '@/lib/services/workflows/shared/articleExtraction';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCallStructured = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/workflows/shared/workflowLlm', () => ({
  callStructured: mockCallStructured,
  createAzureClient: vi.fn(() => ({})),
}));

const encoder = new TextEncoder();

function fixture(name: string): Uint8Array {
  const path = fileURLToPath(
    new URL(`../../../../fixtures/html/${name}`, import.meta.url),
  );
  return encoder.encode(readFileSync(path, 'utf-8'));
}

const html = (bytes: Uint8Array, url = 'https://news.example.com/floods') =>
  extractReadableContent({
    bytes,
    contentType: 'text/html; charset=utf-8',
    resolvedUrl: url,
    isHtml: true,
  });

beforeEach(() => {
  mockCallStructured.mockReset();
});

describe('extractReadableContent — article page', () => {
  it('keeps the article prose', async () => {
    const result = await html(fixture('article-with-boilerplate.html'));

    expect(result.extractedVia).toBe('readability');
    expect(result.text).toContain('floodwaters reached the outskirts of Bor');
    expect(result.text).toContain('Panyagor');
    expect(result.text).toContain('reinforce the dyke system north of Bor');
  });

  it('drops navigation, sidebar, related links and footer', async () => {
    const { text } = await html(fixture('article-with-boilerplate.html'));

    // Nav / header chrome
    expect(text).not.toContain('Subscribe');
    expect(text).not.toContain('Newsletter signup');
    // Sidebar link farm
    expect(text).not.toContain('Most read');
    expect(text).not.toContain('Fuel prices climb in Nairobi');
    // "Related articles" — the exact trap: these name real places the
    // article never discusses, and would otherwise land on the map.
    expect(text).not.toContain('Related articles');
    expect(text).not.toContain('Cholera response scales up in Malakal');
    expect(text).not.toContain('Schools reopen in Torit');
    // Footer
    expect(text).not.toContain('All rights reserved');
    expect(text).not.toContain('Privacy policy');
  });

  /**
   * The single strongest assertion in this suite: whatever survives, the
   * model must never see a URL it could be diverted by.
   */
  it('strips every link target while keeping the link text', async () => {
    const { text } = await html(fixture('article-with-boilerplate.html'));

    expect(text).not.toMatch(/\]\(https?:/);
    expect(text).not.toMatch(/https?:\/\//);
    // ...but the words the author wrote are still there.
    expect(text).toContain('the latest situation report');
    expect(text).toContain('UNHCR field office in Bentiu');
  });

  it('preserves heading structure and the page title', async () => {
    const result = await html(fixture('article-with-boilerplate.html'));

    expect(result.text).toContain('## Conditions in the displacement sites');
    expect(result.title).toContain('Floods displace thousands across Jonglei');
    expect(result.siteName).toBe('Example News');
  });

  it('does not call the model when Readability succeeds', async () => {
    await html(fixture('article-with-boilerplate.html'));
    expect(mockCallStructured).not.toHaveBeenCalled();
  });
});

describe('extractReadableContent — listing page', () => {
  it('falls back, still strips chrome and URLs', async () => {
    const { text, extractedVia } = await html(
      fixture('listing-page.html'),
      'https://relief.example.org/reports',
    );

    expect(extractedVia).toBe('fallback');
    expect(text).toContain('Sudan: Flash Update No. 12');
    expect(text).not.toContain('Subscribe');
    expect(text).not.toContain('All rights reserved');
    expect(text).not.toMatch(/https?:\/\//);
  });
});

describe('extractReadableContent — LLM fallback', () => {
  const asideOnly = encoder.encode(`<!doctype html>
    <html><head><title>Odd layout</title></head><body>
      <aside>
        Convoys reached Malakal on Friday after the road from Renk was
        cleared, and a second team continued toward Melut the same evening.
      </aside>
    </body></html>`);

  it('escalates to the model when the deterministic paths come up empty', async () => {
    mockCallStructured.mockResolvedValue({
      text: 'Convoys reached Malakal on Friday after the road from Renk was cleared, and a second team continued toward Melut the same evening.',
    });

    const result = await html(asideOnly, 'https://example.org/odd');

    expect(mockCallStructured).toHaveBeenCalledTimes(1);
    expect(result.extractedVia).toBe('llm');
    expect(result.text).toContain('Malakal');
  });

  it('throws EMPTY_EXTRACTION when nothing readable is recovered', async () => {
    const empty = encoder.encode(
      '<!doctype html><html><body><div></div></body></html>',
    );

    await expect(
      html(empty, 'https://example.org/blank'),
    ).rejects.toMatchObject({ code: 'EMPTY_EXTRACTION' });
    // Nothing to hand the model, so it is never called.
    expect(mockCallStructured).not.toHaveBeenCalled();
  });
});

describe('extractReadableContent — non-HTML', () => {
  it('passes plain text through untouched', async () => {
    const text =
      'Displacement reported in Bor, Panyagor and Malakal during the week.';
    const result = await extractReadableContent({
      bytes: encoder.encode(text),
      contentType: 'text/plain',
      resolvedUrl: 'https://example.org/notes.txt',
      isHtml: false,
    });

    expect(result.extractedVia).toBe('plaintext');
    expect(result.text).toBe(text);
  });
});

describe('decodeBody', () => {
  it('honours the charset declared in the Content-Type header', () => {
    // 0xE9 is "é" in latin1 but invalid utf-8 — proof the label is used.
    const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9]);
    expect(decodeBody(bytes, 'text/html; charset=iso-8859-1')).toBe('Café');
  });

  it('falls back to utf-8 for an unknown charset label', () => {
    const bytes = encoder.encode('Bor');
    expect(decodeBody(bytes, 'text/html; charset=not-a-charset')).toBe('Bor');
  });
});
