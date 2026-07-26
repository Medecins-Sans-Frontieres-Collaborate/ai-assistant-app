import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-text conformance guard for admin surfaces.
 *
 * The limits admin shipped with controls that had no dark background, no
 * focus ring, and shades that drifted from the rest of the app. None of that
 * is catchable by a normal test: jsdom has no cascade and no layout, so it
 * cannot see a contrast failure or a missing focus ring. Reading the source
 * text can — the same trick __tests__/lib/services/limits/catalog.test.ts
 * already uses to keep the limit catalog honest.
 *
 * SCOPE IS DELIBERATELY NARROW: components/Limits and components/Admin only.
 * Running the pairing rule over components/AgentAccess today reports ~70
 * pre-existing violations in files this change does not restyle; a guard that
 * starts red is a guard everyone learns to ignore. Widen it when those files
 * are brought over.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const SCOPED_DIRS = ['components/Limits', 'components/Admin'];

function walk(dir: string): string[] {
  const full = resolve(REPO_ROOT, dir);
  let entries: string[] = [];
  try {
    entries = readdirSync(full);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(full, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(relative(REPO_ROOT, path)));
    } else if (['.tsx', '.ts'].includes(extname(entry))) {
      files.push(path);
    }
  }
  return files;
}

const FILES = SCOPED_DIRS.flatMap(walk);

/** Every className="…" and className={`…`} literal in a source file. */
function classStrings(source: string): string[] {
  const out: string[] = [];
  const quoted = source.matchAll(/className="([^"]*)"/g);
  for (const m of quoted) out.push(m[1]);
  const templated = source.matchAll(/className=\{`([^`]*)`\}/g);
  for (const m of templated) out.push(m[1]);
  return out;
}

/** Colourless utilities that need no dark: sibling. */
const COLOURLESS = new Set([
  'bg-white',
  'bg-black',
  'bg-transparent',
  'bg-clip-text',
  'text-white',
  'text-black',
  'text-transparent',
  'border-transparent',
]);

/** Solid brand fills that are intentionally identical in both themes. */
const THEME_INVARIANT = new Set([
  'bg-blue-600',
  'bg-blue-700',
  'bg-red-600',
  'bg-red-700',
]);

describe('admin surface conformance', () => {
  it('scans a non-empty set of files', () => {
    // Guards the guard: a broken glob would silently pass everything.
    expect(FILES.length).toBeGreaterThan(4);
  });

  /**
   * Invariant 1 — positive, so it cannot be defeated by inventing a new wrong
   * colour: any admin file that renders a form control must source its
   * classes from the shared vocabulary.
   */
  it('every file rendering a form control imports the shared control classes', () => {
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      if (!/<(select|input|textarea)\b/.test(source)) continue;
      expect(
        /ADMIN_FIELD|ADMIN_CHECKBOX/.test(source),
        `${relative(REPO_ROOT, file)} renders a form control but does not use ADMIN_FIELD/ADMIN_CHECKBOX from @/components/Admin/adminClasses`,
      ).toBe(true);
    }
  });

  /**
   * Invariant 2 — a colour utility that paints a surface must declare what it
   * does in dark mode. Variant-prefixed utilities (hover:, focus:, disabled:)
   * are skipped: they describe a state, and their base already carries the
   * pairing.
   */
  it('colour utilities are paired light/dark', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      for (const classString of classStrings(readFileSync(file, 'utf8'))) {
        const utilities = classString.split(/\s+/).filter(Boolean);
        for (const utility of utilities) {
          if (/^[a-z-]+:/.test(utility)) continue; // hover:, dark:, focus:…
          if (!/^(bg|text|border|placeholder)-/.test(utility)) continue;
          if (COLOURLESS.has(utility) || THEME_INVARIANT.has(utility)) continue;
          // Purely structural border widths/sides carry no colour.
          if (/^border(-[trbl])?(-\d+)?$/.test(utility)) continue;
          if (!/-(\d{2,3})(\/\d+)?$/.test(utility)) continue;
          const prefix = utility.split('-')[0];
          if (!new RegExp(`\\bdark:${prefix}-`).test(classString)) {
            violations.push(
              `${relative(REPO_ROOT, file)}: "${utility}" has no dark: counterpart in the same class string`,
            );
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  /**
   * Invariant 3 — shades that drifted from the rest of the admin area. The
   * failure message names the replacement so the fix needs no archaeology.
   */
  it('uses the agreed shades', () => {
    const DENYLIST: Array<[string, string]> = [
      ['dark:bg-red-900/30', 'dark:bg-red-900/20 (via ADMIN_BANNER_ERROR)'],
      ['dark:bg-red-900/40', 'dark:bg-red-900/30 (via ADMIN_CHIP_DANGER)'],
      ['dark:text-red-200', 'dark:text-red-300'],
      ['dark:bg-amber-900/30', 'dark:bg-amber-900/20 (via ADMIN_BANNER_WARN)'],
      ['dark:text-amber-200', 'dark:text-amber-300'],
      ['uppercase tracking-wide', 'ADMIN_HEADING'],
    ];
    const violations: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const [bad, good] of DENYLIST) {
        // adminClasses.ts itself defines the approved strings.
        if (file.endsWith('adminClasses.ts')) continue;
        if (source.includes(bad)) {
          violations.push(
            `${relative(REPO_ROOT, file)}: "${bad}" → use ${good}`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
