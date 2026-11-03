import {
  parseSkillBundle,
  serializeSkillBundle,
} from '@/lib/services/skills/skillBundle';
import { validateSkillFiles } from '@/lib/services/skills/skillFiles';
import { SKILL_LIMITS } from '@/lib/services/skills/types';

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

const skill = {
  id: 'gdpr',
  name: 'GDPR',
  description: 'Privacy guidance',
  instructions:
    'See [policy](references/nested/policy.md). Say "verified" only with evidence.',
  activation: 'auto' as const,
  applyToAgents: false,
  foreignFrontmatter: { license: 'See LICENSE' },
};
const resources = [
  { path: 'references/nested/policy.md', bytes: strToU8('Policy facts.') },
  { path: 'LICENSE', bytes: strToU8('Copyright MSF') },
];
describe('skill ZIP interchange', () => {
  it('round-trips nested references, license files, and quoted instructions', () => {
    const parsed = parseSkillBundle(serializeSkillBundle(skill, resources));
    expect(parsed.skill).toEqual(skill);
    expect(parsed.resources).toEqual(resources);
  });
  it('skips scripts and keeps assets without executing them', () => {
    const archive = zipSync({
      'gdpr/SKILL.md': strToU8(
        '---\nname: gdpr\ndescription: Privacy\n---\nInstructions',
      ),
      'gdpr/scripts/run.py': strToU8('raise Exception()'),
      'gdpr/assets/template.txt': strToU8('template'),
    });
    const parsed = parseSkillBundle(archive);
    expect(parsed.skipped).toEqual(['scripts/run.py']);
    expect(parsed.resources.map((item) => item.path)).toEqual([
      'assets/template.txt',
    ]);
  });
  it.each([
    '../outside.md',
    '/absolute.md',
    'references/../../outside.md',
    'references\\outside.md',
  ])('rejects unsafe path %s', (path) => {
    expect(() =>
      serializeSkillBundle(skill, [{ path, bytes: strToU8('bad') }]),
    ).toThrow();
  });
  it('rejects multiple skills or a directory/name mismatch', () => {
    const manifest = strToU8('---\nname: gdpr\ndescription: d\n---\nBody');
    expect(() =>
      parseSkillBundle(
        zipSync({ 'gdpr/SKILL.md': manifest, 'other/SKILL.md': manifest }),
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      parseSkillBundle(zipSync({ 'other/SKILL.md': manifest })),
    ).toThrow(/folder name/);
  });
  it('bounds actual decompressed content for highly compressed archives', () => {
    const archive = zipSync(
      {
        'SKILL.md': strToU8('---\nname: gdpr\ndescription: d\n---\nBody'),
        'references/bomb.txt': new Uint8Array(
          SKILL_LIMITS.maxDocumentBytes + 1,
        ),
      },
      { level: 9 },
    );
    expect(archive.length).toBeLessThan(SKILL_LIMITS.maxDocumentBytes);
    expect(() => parseSkillBundle(archive)).toThrow(/size limits/);
  });
  it('brackets file count, size, and aggregate limits', () => {
    expect(() =>
      validateSkillFiles([
        { name: 'a.md', size: SKILL_LIMITS.maxDocumentBytes },
      ]),
    ).not.toThrow();
    expect(() =>
      validateSkillFiles([
        { name: 'a.md', size: SKILL_LIMITS.maxDocumentBytes + 1 },
      ]),
    ).toThrow();
    expect(() =>
      validateSkillFiles(
        Array.from({ length: 21 }, (_, i) => ({ name: `${i}.md`, size: 1 })),
      ),
    ).toThrow();
    expect(() =>
      validateSkillFiles(
        ['a', 'b', 'c'].map((name) => ({
          name: `${name}.md`,
          size: SKILL_LIMITS.maxDocumentBytes,
        })),
      ),
    ).toThrow(/total/);
  });
});
