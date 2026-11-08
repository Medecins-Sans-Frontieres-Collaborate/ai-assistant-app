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

/**
 * Symmetric localization completeness test.
 *
 * Checks all locale files in /messages/ against each other to find missing keys.
 * No locale is treated as the "reference" - if any locale has a key that another
 * locale lacks, the missing key is reported for the locale that lacks it.
 * Uses recursive key flattening to detect missing nested keys.
 */
describe('Localization Completeness', () => {
  it('should have no missing keys across all locales', () => {
    const messagesDir = path.join(process.cwd(), 'messages');
    const localeFiles = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.json'));

    expect(localeFiles.length).toBeGreaterThan(0);

    // Build map: locale -> Set of flattened keys (including nested)
    const localeKeys: Map<string, Set<string>> = new Map();
    for (const file of localeFiles) {
      const locale = file.replace('.json', '');
      const filePath = path.join(messagesDir, file);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      localeKeys.set(locale, new Set(flattenKeys(content)));
    }

    // Build union of all keys across all locales
    const allKeys = new Set<string>();
    for (const keys of localeKeys.values()) {
      keys.forEach((k) => allKeys.add(k));
    }

    // Find missing keys for each locale
    const missingByLocale: Map<string, string[]> = new Map();
    for (const [locale, keys] of localeKeys) {
      const missing = [...allKeys].filter((k) => !keys.has(k)).sort();
      if (missing.length > 0) {
        missingByLocale.set(locale, missing);
      }
    }

    // Assert and report
    if (missingByLocale.size > 0) {
      const sortedLocales = [...missingByLocale.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      );
      const report = sortedLocales
        .map(([locale, keys]) => `  ${locale}: ${keys.join(', ')}`)
        .join('\n');

      const totalMissing = sortedLocales.reduce(
        (sum, [, keys]) => sum + keys.length,
        0,
      );

      expect.fail(
        `Found ${totalMissing} missing key(s) across ${missingByLocale.size} locale(s):\n${report}`,
      );
    }
  });
});
