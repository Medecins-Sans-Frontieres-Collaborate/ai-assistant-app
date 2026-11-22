import {
  PackageFormatError,
  readPackageDirectory,
  readPackageEntry,
  readPackagePart,
  writePackage,
} from '@/lib/services/documents/render/ooxmlPackage';

import { Zip, ZipDeflate, strToU8, unzipSync, zipSync } from 'fflate';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Office packages read part by part and copied with parts replaced. The
 * packages here are made with fflate, an independent zip implementation,
 * which also reads the copies back: what this module writes must be a
 * package another tool accepts.
 */

let dir: string;
const at = (name: string) => path.join(dir, name);

/** A small deck-shaped package. */
const PARTS: Record<string, Uint8Array> = {
  '[Content_Types].xml': strToU8('<Types/>'),
  'ppt/slides/slide1.xml': strToU8('<p:sld><a:t>Hello</a:t></p:sld>'),
  'ppt/media/image1.png': new Uint8Array(200_000).map(
    (_, i) => (i * 7919) % 251,
  ),
  'ppt/vbaProject.bin': new Uint8Array([1, 2, 3, 4, 5]),
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ooxml-package-test-'));
  fs.writeFileSync(at('deck.pptx'), zipSync(PARTS));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reading', () => {
  it('lists every part and reads one without the others', async () => {
    const entries = await readPackageDirectory(at('deck.pptx'));
    expect(entries.map((entry) => entry.name)).toEqual(Object.keys(PARTS));
    const slide = await readPackagePart(
      at('deck.pptx'),
      entries,
      'ppt/slides/slide1.xml',
      1024,
    );
    expect(slide?.toString()).toBe('<p:sld><a:t>Hello</a:t></p:sld>');
    expect(
      await readPackagePart(at('deck.pptx'), entries, 'missing.xml', 1024),
    ).toBeUndefined();
  });

  it('reads a part exactly at its cap and refuses one byte over', async () => {
    const entries = await readPackageDirectory(at('deck.pptx'));
    const media = entries.find(
      (entry) => entry.name === 'ppt/media/image1.png',
    )!;
    await expect(
      readPackageEntry(at('deck.pptx'), media, 200_000),
    ).resolves.toHaveLength(200_000);
    await expect(
      readPackageEntry(at('deck.pptx'), media, 199_999),
    ).rejects.toBeInstanceOf(PackageFormatError);
  });

  it('refuses a part that expands past its cap even when its size is understated', async () => {
    // 50 MB of zeros compresses to a few kilobytes: a zip bomb.
    const bomb = zipSync({
      'ppt/slides/slide1.xml': new Uint8Array(50 * 1024 * 1024),
    });
    // Make the directory claim the part is tiny.
    const bytes = Buffer.from(bomb);
    const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(10, central + 24);
    fs.writeFileSync(at('bomb.pptx'), bytes);
    const [entry] = await readPackageDirectory(at('bomb.pptx'));
    expect(entry.uncompressedSize).toBe(10);
    await expect(
      readPackageEntry(at('bomb.pptx'), entry, 1024 * 1024),
    ).rejects.toBeInstanceOf(PackageFormatError);
  });

  it('notices a damaged part by its checksum', async () => {
    const stored = Buffer.from(
      zipSync({ 'a.xml': strToU8('<abcdef/>') }, { level: 0 }),
    );
    stored[stored.indexOf('<abcdef/>') + 1] = 0x7a; // one byte changed
    fs.writeFileSync(at('damaged.pptx'), stored);
    const [entry] = await readPackageDirectory(at('damaged.pptx'));
    await expect(
      readPackageEntry(at('damaged.pptx'), entry, 1024),
    ).rejects.toThrow('damaged');
  });

  it('refuses what is not a package, or is cut short', async () => {
    fs.writeFileSync(at('junk.pptx'), Buffer.alloc(5_000, 0x41));
    await expect(readPackageDirectory(at('junk.pptx'))).rejects.toThrow(
      'not a zip',
    );
    const whole = fs.readFileSync(at('deck.pptx'));
    fs.writeFileSync(at('cut.pptx'), whole.subarray(0, whole.length - 30));
    await expect(readPackageDirectory(at('cut.pptx'))).rejects.toBeInstanceOf(
      PackageFormatError,
    );
  });

  it('refuses part names that could escape a folder', async () => {
    fs.writeFileSync(
      at('escape.pptx'),
      zipSync({ '../evil.xml': strToU8('<x/>') }),
    );
    await expect(readPackageDirectory(at('escape.pptx'))).rejects.toThrow(
      'invalid part name',
    );
  });
});

describe('writing a copy', () => {
  it('replaces the named parts and copies every other byte for byte', async () => {
    const replaced = strToU8('<p:sld><a:t>Bonjour</a:t></p:sld>');
    await writePackage(
      at('deck.pptx'),
      at('copy.pptx'),
      new Map([['ppt/slides/slide1.xml', Buffer.from(replaced)]]),
    );
    const copy = unzipSync(fs.readFileSync(at('copy.pptx')));
    expect(Object.keys(copy)).toEqual(Object.keys(PARTS)); // same order
    expect(Buffer.from(copy['ppt/slides/slide1.xml']).toString()).toBe(
      '<p:sld><a:t>Bonjour</a:t></p:sld>',
    );
    expect(copy['ppt/media/image1.png']).toEqual(PARTS['ppt/media/image1.png']);
    expect(copy['ppt/vbaProject.bin']).toEqual(PARTS['ppt/vbaProject.bin']);
    // And this module reads its own output.
    const entries = await readPackageDirectory(at('copy.pptx'));
    expect(entries).toHaveLength(4);
  });

  it('copies parts written with trailing size records (streamed zips)', async () => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk) => {
      if (error) throw error;
      chunks.push(chunk);
    });
    const part = new ZipDeflate('ppt/slides/slide1.xml', { level: 6 });
    zip.add(part);
    part.push(strToU8('<p:sld>streamed</p:sld>'), true);
    zip.end();
    fs.writeFileSync(at('streamed.pptx'), Buffer.concat(chunks));
    const [entry] = await readPackageDirectory(at('streamed.pptx'));
    expect(entry.flags & 0x8).toBe(0x8); // sizes after the data
    await writePackage(
      at('streamed.pptx'),
      at('streamed-copy.pptx'),
      new Map(),
    );
    const copy = unzipSync(fs.readFileSync(at('streamed-copy.pptx')));
    expect(Buffer.from(copy['ppt/slides/slide1.xml']).toString()).toBe(
      '<p:sld>streamed</p:sld>',
    );
  });

  it('refuses to replace a part the package does not have, and leaves no file', async () => {
    await expect(
      writePackage(
        at('deck.pptx'),
        at('never.pptx'),
        new Map([['ppt/new.xml', Buffer.from('x')]]),
      ),
    ).rejects.toThrow('no part ppt/new.xml');
    expect(fs.existsSync(at('never.pptx'))).toBe(false);
  });
});
