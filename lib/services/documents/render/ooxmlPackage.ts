/**
 * Reading parts of an Office package (a zip: .pptx, .pptm, .docx) and
 * writing a copy with some parts replaced, working on files, never on the
 * whole package in memory.
 *
 * - The directory is read from the end of the file; a part is read by
 *   seeking to it, so a deck's media is never loaded to read its text.
 * - A part is inflated with a cap on its size (`maxBytes`), so a small
 *   compressed part that expands enormously (a zip bomb) is refused.
 * - Writing copies every part that is not replaced byte for byte, still
 *   compressed, in the original order: pictures, macros (`vbaProject.bin`)
 *   and anything unknown come out exactly as they went in.
 * - Refused: ZIP64 packages (over 4 GB or 65,535 parts), encrypted
 *   entries, duplicate or unsafe part names, more than MAX_PACKAGE_ENTRIES.
 */
import fs from 'fs';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';

/** One part of a package, as its directory describes it. */
export interface PackageEntry {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dosTime: number;
  dosDate: number;
}

/** Parts a package may have. A 300-slide deck has about 2,000. */
export const MAX_PACKAGE_ENTRIES = 20_000;

/** Raised for a package this code will not read or write. */
export class PackageFormatError extends Error {
  readonly code = 'PACKAGE_UNREADABLE';
  constructor(message: string) {
    super(message);
    this.name = 'PackageFormatError';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const ENCRYPTED_FLAG = 0x1;
const DATA_DESCRIPTOR_FLAG = 0x8;
const UTF8_FLAG = 0x800;
const ZIP64_MARK_32 = 0xffffffff;
const ZIP64_MARK_16 = 0xffff;

async function readAt(
  handle: fs.promises.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new PackageFormatError('The package is truncated.');
  }
  return buffer;
}

/** A part name that could not escape a folder or collide with another. */
function isSafeName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !name.split('/').includes('..') &&
    !name.includes('\0')
  );
}

/**
 * Reads a package's directory.
 *
 * @param filePath - The package on disk.
 * @returns Its parts, in directory order.
 * @throws PackageFormatError for anything this code will not handle.
 */
export async function readPackageDirectory(
  filePath: string,
): Promise<PackageEntry[]> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < EOCD_MIN_BYTES) {
      throw new PackageFormatError('The file is too small to be a package.');
    }
    const tailLength = Math.min(size, EOCD_MIN_BYTES + MAX_COMMENT_BYTES);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let eocd = -1;
    for (let at = tail.length - EOCD_MIN_BYTES; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) === EOCD_SIGNATURE) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) {
      throw new PackageFormatError('The file is not a zip package.');
    }
    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (
      count === ZIP64_MARK_16 ||
      directorySize === ZIP64_MARK_32 ||
      directoryOffset === ZIP64_MARK_32
    ) {
      throw new PackageFormatError('Packages over 4 GB are not supported.');
    }
    if (count > MAX_PACKAGE_ENTRIES) {
      throw new PackageFormatError(
        `The package has ${count} parts; at most ${MAX_PACKAGE_ENTRIES} are read.`,
      );
    }
    if (directoryOffset + directorySize > size) {
      throw new PackageFormatError('The package directory is damaged.');
    }
    const directory = await readAt(handle, directoryOffset, directorySize);
    const entries: PackageEntry[] = [];
    const seen = new Set<string>();
    let at = 0;
    for (let index = 0; index < count; index += 1) {
      if (
        at + 46 > directory.length ||
        directory.readUInt32LE(at) !== CENTRAL_SIGNATURE
      ) {
        throw new PackageFormatError('The package directory is damaged.');
      }
      const flags = directory.readUInt16LE(at + 8);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const name = directory
        .subarray(at + 46, at + 46 + nameLength)
        .toString(flags & UTF8_FLAG ? 'utf8' : 'latin1');
      const entry: PackageEntry = {
        name,
        flags,
        method: directory.readUInt16LE(at + 10),
        dosTime: directory.readUInt16LE(at + 12),
        dosDate: directory.readUInt16LE(at + 14),
        crc32: directory.readUInt32LE(at + 16),
        compressedSize: directory.readUInt32LE(at + 20),
        uncompressedSize: directory.readUInt32LE(at + 24),
        localHeaderOffset: directory.readUInt32LE(at + 42),
      };
      if (flags & ENCRYPTED_FLAG) {
        throw new PackageFormatError('The package has encrypted parts.');
      }
      if (entry.method !== 0 && entry.method !== 8) {
        throw new PackageFormatError(
          `Part ${name} uses an unsupported compression method.`,
        );
      }
      if (
        entry.compressedSize === ZIP64_MARK_32 ||
        entry.uncompressedSize === ZIP64_MARK_32 ||
        entry.localHeaderOffset === ZIP64_MARK_32
      ) {
        throw new PackageFormatError('Packages over 4 GB are not supported.');
      }
      if (!isSafeName(name) || seen.has(name)) {
        throw new PackageFormatError(`The package has an invalid part name.`);
      }
      seen.add(name);
      entries.push(entry);
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Where a part's compressed bytes start: after its local header. */
async function dataOffset(
  handle: fs.promises.FileHandle,
  entry: PackageEntry,
): Promise<number> {
  const header = await readAt(handle, entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new PackageFormatError(`Part ${entry.name} is damaged.`);
  }
  return (
    entry.localHeaderOffset +
    30 +
    header.readUInt16LE(26) +
    header.readUInt16LE(28)
  );
}

/**
 * Reads one part, uncompressed.
 *
 * @param filePath - The package on disk.
 * @param entry - The part, from readPackageDirectory.
 * @param maxBytes - Largest uncompressed size accepted.
 * @throws PackageFormatError when the part is larger than `maxBytes`, or
 *   damaged (its checksum does not match).
 */
export async function readPackageEntry(
  filePath: string,
  entry: PackageEntry,
  maxBytes: number,
): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) {
    throw new PackageFormatError(
      `Part ${entry.name} is larger than ${maxBytes} bytes.`,
    );
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const start = await dataOffset(handle, entry);
    const compressed = await readAt(handle, start, entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) {
      data = compressed;
    } else {
      try {
        data = zlib.inflateRawSync(compressed, {
          // The directory's size can lie; the cap holds regardless.
          maxOutputLength: Math.max(1, maxBytes),
        });
      } catch {
        throw new PackageFormatError(
          `Part ${entry.name} could not be read or is larger than ${maxBytes} bytes.`,
        );
      }
    }
    if (zlib.crc32(data) >>> 0 !== entry.crc32 >>> 0) {
      throw new PackageFormatError(`Part ${entry.name} is damaged.`);
    }
    return data;
  } finally {
    await handle.close();
  }
}

/**
 * Reads a part by name; undefined when the package has no such part.
 */
export async function readPackagePart(
  filePath: string,
  entries: PackageEntry[],
  name: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const entry = entries.find((candidate) => candidate.name === name);
  return entry ? readPackageEntry(filePath, entry, maxBytes) : undefined;
}

/** Today's time in the DOS format zip headers use. */
function dosNow(): { time: number; date: number } {
  const now = new Date();
  return {
    time:
      (now.getHours() << 11) |
      (now.getMinutes() << 5) |
      Math.floor(now.getSeconds() / 2),
    date:
      ((Math.max(1980, now.getFullYear()) - 1980) << 9) |
      ((now.getMonth() + 1) << 5) |
      now.getDate(),
  };
}

function localHeader(entry: PackageEntry, nameBytes: Buffer): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(entry.dosTime, 10);
  header.writeUInt16LE(entry.dosDate, 12);
  header.writeUInt32LE(entry.crc32 >>> 0, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.uncompressedSize, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes]);
}

function centralHeader(entry: PackageEntry, nameBytes: Buffer): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.dosTime, 12);
  header.writeUInt16LE(entry.dosDate, 14);
  header.writeUInt32LE(entry.crc32 >>> 0, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt32LE(entry.localHeaderOffset, 42);
  return Buffer.concat([header, nameBytes]);
}

/** Writes `data` to a stream, waiting when it is full. */
async function writeTo(stream: fs.WriteStream, data: Buffer): Promise<void> {
  if (!stream.write(data)) {
    await new Promise<void>((resolve) => stream.once('drain', resolve));
  }
}

/**
 * Writes a copy of a package with some parts replaced.
 *
 * @param sourcePath - The package to copy.
 * @param outPath - Where the copy is written (must differ from the source).
 * @param replacements - Part name to its new, uncompressed content. Every
 *   name must already be a part of the package.
 * @param removals - Parts left out of the copy (the caller also removes
 *   whatever refers to them).
 * @throws PackageFormatError when the source cannot be read, a replacement
 *   or removal names a part the package does not have, or the copy would
 *   exceed 4 GB.
 */
export async function writePackage(
  sourcePath: string,
  outPath: string,
  replacements: ReadonlyMap<string, Buffer>,
  removals: ReadonlySet<string> = new Set(),
): Promise<void> {
  const entries = await readPackageDirectory(sourcePath);
  const names = new Set(entries.map((entry) => entry.name));
  for (const name of [...replacements.keys(), ...removals]) {
    if (!names.has(name)) {
      throw new PackageFormatError(`The package has no part ${name}.`);
    }
  }
  const source = await fs.promises.open(sourcePath, 'r');
  const out = fs.createWriteStream(outPath);
  const written: PackageEntry[] = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      if (removals.has(entry.name)) continue;
      const nameBytes = Buffer.from(entry.name, 'utf8');
      // Sizes always go in the header, never in a trailing descriptor.
      const flags = (entry.flags & ~DATA_DESCRIPTOR_FLAG) | UTF8_FLAG;
      const replacement = replacements.get(entry.name);
      if (replacement) {
        const compressed = zlib.deflateRawSync(replacement);
        const { time, date } = dosNow();
        const updated: PackageEntry = {
          ...entry,
          flags,
          method: 8,
          crc32: zlib.crc32(replacement) >>> 0,
          compressedSize: compressed.length,
          uncompressedSize: replacement.length,
          localHeaderOffset: offset,
          dosTime: time,
          dosDate: date,
        };
        const header = localHeader(updated, nameBytes);
        await writeTo(out, header);
        await writeTo(out, compressed);
        offset += header.length + compressed.length;
        written.push(updated);
      } else {
        const copied: PackageEntry = {
          ...entry,
          flags,
          localHeaderOffset: offset,
        };
        const header = localHeader(copied, nameBytes);
        await writeTo(out, header);
        const start = await dataOffset(source, entry);
        if (entry.compressedSize > 0) {
          await pipeline(
            fs.createReadStream(sourcePath, {
              start,
              end: start + entry.compressedSize - 1,
            }),
            out,
            { end: false },
          );
        }
        offset += header.length + entry.compressedSize;
        written.push(copied);
      }
      if (offset > ZIP64_MARK_32) {
        throw new PackageFormatError('The copy would exceed 4 GB.');
      }
    }
    const directoryStart = offset;
    for (const entry of written) {
      const header = centralHeader(entry, Buffer.from(entry.name, 'utf8'));
      await writeTo(out, header);
      offset += header.length;
    }
    const end = Buffer.alloc(EOCD_MIN_BYTES);
    end.writeUInt32LE(EOCD_SIGNATURE, 0);
    end.writeUInt16LE(written.length, 8);
    end.writeUInt16LE(written.length, 10);
    end.writeUInt32LE(offset - directoryStart, 12);
    end.writeUInt32LE(directoryStart, 16);
    await writeTo(out, end);
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    out.destroy();
    await fs.promises.rm(outPath, { force: true });
    throw error;
  } finally {
    await source.close();
  }
}
