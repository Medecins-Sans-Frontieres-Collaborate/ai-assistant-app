/** Bounded Agent Skills ZIP interchange. Paths never become filesystem paths. */
import { validateResourcePath, validateSkillFiles } from './skillFiles';
import {
  ParsedSkillMarkdown,
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from './skillMarkdown';
import { SKILL_LIMITS } from './types';

import { Unzip, UnzipInflate, strFromU8, strToU8, zipSync } from 'fflate';

export interface SkillBundleResource {
  path: string;
  bytes: Uint8Array;
}
export interface SkillBundle {
  skill: ParsedSkillMarkdown;
  resources: SkillBundleResource[];
  skipped: string[];
}

/** Reads a single skill folder, bounding actual inflated bytes, not just ZIP headers. */
export function parseSkillBundle(bytes: Uint8Array): SkillBundle {
  if (bytes.length > SKILL_LIMITS.maxBundleBytes)
    throw new Error('Skill ZIP exceeds 20 MB');
  const entries = new Map<string, Uint8Array>();
  const names = new Set<string>();
  let total = 0;
  let entryCount = 0;
  const unzip = new Unzip((file) => {
    if (++entryCount > 100) throw new Error('Skill ZIP has too many entries');
    const directory = file.name.endsWith('/');
    const name = validateResourcePath(
      directory ? file.name.slice(0, -1) : file.name,
    );
    if (directory) return;
    if (names.has(name.toLowerCase()))
      throw new Error(`Duplicate ZIP entry: ${name}`);
    names.add(name.toLowerCase());
    let size = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, data, final) => {
      if (error) throw error;
      size += data.length;
      total += data.length;
      if (
        size > SKILL_LIMITS.maxDocumentBytes ||
        total > SKILL_LIMITS.maxBundleBytes
      ) {
        file.terminate();
        throw new Error('Expanded skill ZIP exceeds resource size limits');
      }
      chunks.push(data);
      if (final) {
        const output = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.length;
        }
        entries.set(name, output);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small input slices keep streaming decompression bounded even for a ZIP
  // whose declared sizes lie about a very large decompressed payload.
  for (let offset = 0; offset < bytes.length; offset += 4096)
    unzip.push(
      bytes.subarray(offset, offset + 4096),
      offset + 4096 >= bytes.length,
    );
  const manifests = [...entries.keys()].filter(
    (name) => name === 'SKILL.md' || /^[^/]+\/SKILL\.md$/.test(name),
  );
  if (manifests.length !== 1)
    throw new Error(
      'ZIP must contain exactly one SKILL.md at its root or in one skill folder',
    );
  const manifest = manifests[0];
  const root = manifest.slice(0, -'SKILL.md'.length);
  const parsed = parseSkillMarkdown(strFromU8(entries.get(manifest)!));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  if (root && root !== `${parsed.skill.id}/`)
    throw new Error('Skill folder name must match the SKILL.md name');
  const resources: SkillBundleResource[] = [];
  const skipped: string[] = [];
  for (const [name, data] of entries) {
    if (name === manifest) continue;
    if (!name.startsWith(root))
      throw new Error('ZIP contains files outside the skill folder');
    const path = name.slice(root.length);
    if (path.startsWith('scripts/')) {
      skipped.push(path);
      continue;
    }
    resources.push({ path, bytes: data });
  }
  validateSkillFiles(
    resources.map(({ path, bytes: data }) => ({
      name: path,
      size: data.length,
    })),
  );
  return { skill: parsed.skill, resources, skipped };
}

/** Exports the instruction manifest and original resources with stable relative paths. */
export function serializeSkillBundle(
  skill: ParsedSkillMarkdown,
  resources: SkillBundleResource[],
): Uint8Array {
  validateSkillFiles(
    resources.map(({ path, bytes }) => ({ name: path, size: bytes.length })),
  );
  const entries: Record<string, Uint8Array> = {
    [`${skill.id}/SKILL.md`]: strToU8(serializeSkillMarkdown(skill)),
  };
  for (const resource of resources)
    entries[`${skill.id}/${validateResourcePath(resource.path)}`] =
      resource.bytes;
  return zipSync(entries, { level: 6 });
}
