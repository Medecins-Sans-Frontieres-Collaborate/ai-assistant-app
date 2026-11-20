import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The documents layer (docs/DOCUMENT_PLATFORM.md) knows nothing about the
 * features built on it: its code never imports translation, brand review,
 * the deck builder or any workflow. A feature's knowledge that leaks into it
 * would make the next feature depend on the first.
 */

const ROOT = path.join(__dirname, '../..');

/** Folders that make up the layer. */
const LAYER = [
  'lib/services/documents',
  'lib/services/backgroundJobs',
  'components/Documents',
  'lib/utils/shared/documents',
  'client/hooks/documents',
  'client/hooks/backgroundJobs',
  'client/services/documents',
];

/** Import specifiers the layer must never use. */
const FEATURES: RegExp[] = [
  /^@\/lib\/services\/documentTranslation\b/,
  /^@\/lib\/services\/brand\b/,
  /^@\/lib\/services\/deckBuilder\b/,
  // Shared workflow infrastructure (usage accounting) is allowed.
  /^@\/lib\/services\/workflows\/(?!shared\/)/,
  /^@\/lib\/utils\/shared\/(translation|brand|deckBuilder)\b/,
  /^@\/components\/Workflows\b/,
  /^@\/client\/hooks\/workflows\b/,
  /^@\/client\/services\/workflows\b/,
];

function sourceFiles(dir: string): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** Every module a file imports or re-exports, static or dynamic. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|vi\.mock\(\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found;
}

/** A relative import resolved to a project path, to catch `../../` escapes. */
function resolved(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return `@/${path.normalize(path.join(path.dirname(file), specifier))}`;
}

describe('documents layer import boundary', () => {
  const files = LAYER.flatMap(sourceFiles);

  it('has code to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never imports a feature built on it', () => {
    const leaks = files.flatMap((file) =>
      specifiers(fs.readFileSync(path.join(ROOT, file), 'utf8'))
        .map((specifier) => resolved(file, specifier))
        .filter((target) => FEATURES.some((feature) => feature.test(target)))
        .map((target) => `${file} -> ${target}`),
    );
    expect(leaks).toEqual([]);
  });

  it('catches a leak (the check itself)', () => {
    const file = 'lib/services/documents/render/example.ts';
    const leaking = [
      "import { x } from '@/lib/services/documentTranslation/native/deckRunJob';",
      "const y = await import('@/components/Workflows/registry');",
      "export { z } from '../../documentTranslation/deck/deckText';",
    ].join('\n');
    const targets = specifiers(leaking).map((s) => resolved(file, s));
    expect(
      targets.filter((target) => FEATURES.some((f) => f.test(target))),
    ).toHaveLength(3);
  });
});
