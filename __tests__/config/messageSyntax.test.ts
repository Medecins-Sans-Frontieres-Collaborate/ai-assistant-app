import { SLIDE_WORDED_KEYS } from '@/components/Workflows/Translation/Formatted/formattedWording';

import { parse } from '@formatjs/icu-messageformat-parser';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every message of every locale is valid ICU (a broken one shows its key
 * instead of text), and every string the formatted screens word by unit
 * (formattedWording.tsx) has its slide twin everywhere.
 */

const MESSAGES = path.join(__dirname, '../../messages');
const locales = fs
  .readdirSync(MESSAGES)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length));

type Tree = { [key: string]: string | Tree };
const load = (locale: string): Tree =>
  JSON.parse(fs.readFileSync(path.join(MESSAGES, `${locale}.json`), 'utf8'));

/** Every string of a message tree, by its dotted key. */
function strings(tree: Tree, at = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[`${at}${key}`, value] as [string, string]]
      : strings(value, `${at}${key}.`),
  );
}

describe('message syntax', () => {
  it.each(locales)('every %s message parses', (locale) => {
    const broken = strings(load(locale)).filter(([, text]) => {
      try {
        parse(text);
        return false;
      } catch {
        return true;
      }
    });
    expect(broken.map(([key]) => key)).toEqual([]);
  });

  it.each(locales)(
    '%s has a slide twin of every unit-worded string',
    (locale) => {
      const formatted = (load(locale).workflows as Tree).translation as Tree;
      const slides = (formatted.formatted as Tree).slides as Tree | undefined;
      const at = (key: string): unknown =>
        key
          .split('.')
          .reduce<unknown>(
            (node, part) => (node as Tree | undefined)?.[part],
            slides,
          );
      const missing = SLIDE_WORDED_KEYS.filter(
        (key) => typeof at(key) !== 'string',
      );
      expect(missing).toEqual([]);
    },
  );
});
