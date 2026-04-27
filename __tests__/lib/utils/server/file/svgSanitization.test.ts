import {
  isSvgBuffer,
  sanitizeSvgBuffer,
} from '@/lib/utils/server/file/svgSanitization';

import { describe, expect, it } from 'vitest';

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('isSvgBuffer', () => {
  it('detects an XML prolog SVG', () => {
    expect(isSvgBuffer(buf('<?xml version="1.0"?><svg/>'))).toBe(true);
  });

  it('detects a bare <svg> root', () => {
    expect(isSvgBuffer(buf('<svg xmlns="..."><circle/></svg>'))).toBe(true);
  });

  it('skips a UTF-8 BOM and leading whitespace', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = buf('  \n<svg/>');
    expect(isSvgBuffer(Buffer.concat([bom, body]))).toBe(true);
  });

  it('is case-insensitive on the root tag', () => {
    expect(isSvgBuffer(buf('<SVG/>'))).toBe(true);
  });

  it('returns false for binary image bytes', () => {
    // Plausible PNG header — should not be mistaken for SVG.
    const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]);
    expect(isSvgBuffer(pngHead)).toBe(false);
  });

  it('returns false for short buffers', () => {
    expect(isSvgBuffer(buf('<sv'))).toBe(false);
  });
});

describe('sanitizeSvgBuffer', () => {
  it('passes through a benign SVG with the visible content intact', async () => {
    const result = await sanitizeSvgBuffer(
      buf(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="3"/></svg>',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.sanitized.toString('utf8');
      expect(out).toMatch(/<circle/i);
    }
  });

  it('strips <script> elements', async () => {
    const result = await sanitizeSvgBuffer(
      buf(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="3"/></svg>',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.sanitized.toString('utf8');
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toMatch(/alert/);
    }
  });

  it('strips on* event handler attributes', async () => {
    const result = await sanitizeSvgBuffer(
      buf(
        '<svg onload="alert(1)" xmlns="http://www.w3.org/2000/svg"><circle r="3" onclick="alert(2)"/></svg>',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.sanitized.toString('utf8');
      expect(out).not.toMatch(/onload/i);
      expect(out).not.toMatch(/onclick/i);
      expect(out).not.toMatch(/alert/);
    }
  });

  it('strips foreignObject (XHTML escape hatch)', async () => {
    const result = await sanitizeSvgBuffer(
      buf(
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>nope</div></foreignObject><circle r="3"/></svg>',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.sanitized.toString('utf8');
      expect(out).not.toMatch(/foreignObject/i);
      // KEEP_CONTENT: false ensures the inner <div>nope</div> is also gone,
      // not just the wrapping tag.
      expect(out).not.toMatch(/nope/);
    }
  });

  it('removes javascript: URLs from anchor hrefs', async () => {
    const result = await sanitizeSvgBuffer(
      buf(
        '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><circle r="3"/></a></svg>',
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.sanitized.toString('utf8');
      expect(out).not.toMatch(/javascript:/i);
      expect(out).not.toMatch(/alert/);
    }
  });

  it('rejects buffers larger than the size cap', async () => {
    // 6MB string — cap is 5MB.
    const huge = Buffer.alloc(6 * 1024 * 1024, 'a');
    const result = await sanitizeSvgBuffer(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/maximum size/i);
    }
  });

  it('still strips dangerous content even if the input is partial / non-SVG', async () => {
    // Defence in depth: callers gate with isSvgBuffer() first, but if a
    // malformed input slips through (e.g. an SVG fragment without the
    // <svg> root), the sanitiser must still neutralise scripts rather
    // than passing them through.
    const result = await sanitizeSvgBuffer(
      buf('<g><script>alert(1)</script></g>'),
    );
    if (result.ok) {
      const out = result.sanitized.toString('utf8');
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toMatch(/alert/);
    }
  });
});
