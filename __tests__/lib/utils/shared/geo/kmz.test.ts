import {
  KMZ_MAX_KML_BYTES,
  KmzError,
  kmlFromKmz,
} from '@/lib/utils/shared/geo/kmz';

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

const KML =
  '<?xml version="1.0"?><kml><Document><Placemark><name>A</name></Placemark></Document></kml>';

describe('kmlFromKmz', () => {
  it('returns doc.kml and never touches the other entries', () => {
    const archive = zipSync({
      'doc.kml': strToU8(KML),
      'images/photo.jpg': new Uint8Array(1024),
      'other.kml': strToU8('<kml/>'),
    });
    expect(kmlFromKmz(archive)).toBe(KML);
  });

  it('falls back to the first .kml when there is no doc.kml', () => {
    const archive = zipSync({ 'nested/map.kml': strToU8(KML) });
    expect(kmlFromKmz(archive)).toBe(KML);
  });

  it('refuses an archive with no KML', () => {
    const archive = zipSync({ 'readme.txt': strToU8('hi') });
    expect(() => kmlFromKmz(archive)).toThrow(KmzError);
  });

  it('refuses a KML whose declared size is a decompression bomb, without inflating it', () => {
    // Highly compressible: declared size far over the cap, tiny on disk.
    const big = new Uint8Array(KMZ_MAX_KML_BYTES + 1);
    const archive = zipSync({ 'doc.kml': big }, { level: 9 });
    expect(archive.byteLength).toBeLessThan(200_000);
    expect(() => kmlFromKmz(archive)).toThrow(KmzError);
  });

  it('refuses garbage', () => {
    expect(() => kmlFromKmz(new Uint8Array([1, 2, 3]))).toThrow(KmzError);
  });
});
