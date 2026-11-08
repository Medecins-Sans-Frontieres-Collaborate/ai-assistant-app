import { defaultLocale } from '@/config/i18n';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Recursively flattens nested object keys using dot notation.
 * Example: { help: { faq: { title: "..." } } } => ["help.faq.title"]
 *
 * @param obj - The object to flatten
 * @param prefix - Current key prefix for recursion
 * @returns Array of flattened key paths
 */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return flattenKeys(value as Record<string, unknown>, newKey);
    }
    return [newKey];
  });
}

/** Flattened keys of every locale file in /messages, by locale. */
function loadLocaleKeys(): Map<string, Set<string>> {
  const messagesDir = path.join(process.cwd(), 'messages');
  const localeKeys = new Map<string, Set<string>>();
  for (const file of fs.readdirSync(messagesDir)) {
    if (!file.endsWith('.json')) continue;
    const content = JSON.parse(
      fs.readFileSync(path.join(messagesDir, file), 'utf-8'),
    );
    localeKeys.set(file.replace('.json', ''), new Set(flattenKeys(content)));
  }
  return localeKeys;
}

/** Applies `select` to each locale's keys; keeps locales with a non-empty result, sorted. */
function keysOutside(
  localeKeys: Map<string, Set<string>>,
  select: (keys: Set<string>) => string[],
): [string, string[]][] {
  return [...localeKeys.entries()]
    .map(([locale, keys]): [string, string[]] => [locale, select(keys).sort()])
    .filter(([, keys]) => keys.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

const formatReport = (entries: [string, string[]][]) =>
  entries.map(([locale, keys]) => `  ${locale}: ${keys.join(', ')}`).join('\n');

const countKeys = (entries: [string, string[]][]) =>
  entries.reduce((sum, [, keys]) => sum + keys.length, 0);

/**
 * Localization completeness, measured against the default locale (English),
 * which is the source every other locale is translated from.
 *
 * - FAILS when a locale lacks a key the default locale has: that string
 *   would render untranslated (or as a raw key) for those users.
 * - WARNS (does not fail) when a locale carries keys the default locale no
 *   longer has: leftovers of removed or renamed strings. They are never
 *   looked up, so they cost file size, not correctness.
 */
describe('Localization Completeness', () => {
  const localeKeys = loadLocaleKeys();
  const referenceKeys = localeKeys.get(defaultLocale);

  it('has a message file for the default locale', () => {
    expect(localeKeys.size).toBeGreaterThan(1);
    expect(referenceKeys, `messages/${defaultLocale}.json`).toBeDefined();
  });

  it(`every locale has every ${defaultLocale} key`, () => {
    if (!referenceKeys) return;
    const missing = keysOutside(localeKeys, (keys) =>
      [...referenceKeys].filter((key) => !keys.has(key)),
    );
    if (missing.length > 0) {
      expect.fail(
        `Found ${countKeys(missing)} ${defaultLocale} key(s) missing from ${missing.length} locale(s):\n${formatReport(missing)}`,
      );
    }
  });

  it(`reports keys that ${defaultLocale} no longer has (warning only)`, () => {
    if (!referenceKeys) return;
    const stale = keysOutside(localeKeys, (keys) =>
      [...keys].filter((key) => !referenceKeys.has(key)),
    );
    if (stale.length > 0) {
      // One line per key (not per locale): the same leftover usually sits
      // in most locales, so this keeps the warning short.
      const localesByKey = new Map<string, number>();
      for (const [, keys] of stale)
        for (const key of keys)
          localesByKey.set(key, (localesByKey.get(key) ?? 0) + 1);
      const lines = [...localesByKey.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => `  ${key} (${count} locale(s))`);
      console.warn(
        `[localization] ${localesByKey.size} key(s) that ${defaultLocale} no longer has remain in ${stale.length} locale(s). ` +
          `They are never looked up and can be removed:\n${lines.join('\n')}`,
      );
    }
  });
});
