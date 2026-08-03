import { LIMIT_DEFINITIONS, isValidDimension } from '@/config/limits';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');

describe('limit catalog', () => {
  it('has unique, stable keys', () => {
    const keys = LIMIT_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('defaults almost everything to unlimited or allowed', () => {
    const configured = LIMIT_DEFINITIONS.filter(
      (d) => d.defaultValue !== null && d.defaultValue !== true,
    );
    // Every non-unlimited default must encode behaviour the app ALREADY has,
    // so merging the feature cannot change what any user experiences.
    expect(configured.map((d) => d.key).sort()).toEqual([
      // New flag-gated feature: a non-null default cannot change behaviour
      // any user already has, because the toolset ships dark.
      'feature.m365.mail.deepScansPerDay',
      'feature.m365.mail.draftsPerDay',
      'feature.m365.mail.readsPerDay',
      'feature.m365.toolCallsPerDay',
      'feature.mcp.roundsPerRequest',
    ]);
  });

  it('only ceiling-kind keys carry a hardCeiling', () => {
    for (const def of LIMIT_DEFINITIONS) {
      if (def.hardCeiling !== undefined) {
        expect(def.kind).toBe('ceiling');
      }
    }
  });

  it('counter-kind keys use a windowed period; ceiling-kind keys do not', () => {
    for (const def of LIMIT_DEFINITIONS) {
      if (def.kind === 'counter') {
        expect(['day', 'month']).toContain(def.window);
      } else {
        expect(['request', 'none']).toContain(def.window);
      }
    }
  });

  it('boolean-unit keys default to a boolean and numeric ones do not', () => {
    for (const def of LIMIT_DEFINITIONS) {
      if (def.unit === 'boolean') {
        expect(typeof def.defaultValue).toBe('boolean');
      } else {
        expect(typeof def.defaultValue).not.toBe('boolean');
      }
    }
  });

  /**
   * Drift guard: a catalog key with no enforcement is a lie to the admin.
   * `enforcedAt` names the file that checks the key, so at minimum that file
   * must exist — the file's own tests prove the check inside it.
   */
  it('every key names a real file in enforcedAt', () => {
    for (const def of LIMIT_DEFINITIONS) {
      const path = def.enforcedAt.split(' ')[0];
      expect(
        existsSync(resolve(REPO_ROOT, path)),
        `${def.key} → ${path} does not exist`,
      ).toBe(true);
    }
  });

  it('every enforced key is actually referenced by its enforcing file', () => {
    // Per-model keys are referenced through their catalog definition rather
    // than as a literal string, so they are checked via the shared middleware.
    const skip = new Set(['model.allowed', 'model.requests']);
    for (const def of LIMIT_DEFINITIONS) {
      if (skip.has(def.key)) continue;
      const path = def.enforcedAt.split(' ')[0];
      const full = resolve(REPO_ROOT, path);
      if (!existsSync(full)) continue;
      const source = readFileSync(full, 'utf8');
      expect(
        source.includes(def.key),
        `${def.key} is not referenced in ${path}`,
      ).toBe(true);
    }
  });
});

describe('isValidDimension', () => {
  it('accepts realistic model ids and series', () => {
    for (const value of ['gpt-5.2', 'claude-opus-5', 'o3', 'byom-abc123']) {
      expect(isValidDimension(value)).toBe(true);
    }
  });

  it('rejects path traversal and whitespace', () => {
    for (const value of ['../etc', 'a b', 'a/b', '']) {
      expect(isValidDimension(value)).toBe(false);
    }
  });
});
