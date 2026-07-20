import {
  decodeRecoveryCode,
  encodeRecoveryCode,
  generateMasterKey,
  normalizeRecoveryCode,
} from '@/lib/utils/shared/backupCrypto/recoveryCode';

import { describe, expect, it } from 'vitest';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic key 0x00..0x1f for pinned vectors. */
function fixedKey(): Uint8Array {
  return new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
}

// Pinned regression vector — any change to alphabet, bit packing, or the
// checksum construction breaks every previously issued recovery code.
const FIXED_CODE =
  '000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFG-CC6W';

describe('generateMasterKey', () => {
  it('returns 32 random bytes, distinct per call', () => {
    const a = generateMasterKey();
    const b = generateMasterKey();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('encodeRecoveryCode', () => {
  it('matches the pinned fixed vector', async () => {
    await expect(encodeRecoveryCode(fixedKey())).resolves.toBe(FIXED_CODE);
  });

  it('produces 14 dash-separated groups of 4 Crockford Base32 chars', async () => {
    const code = await encodeRecoveryCode(generateMasterKey());
    const groups = code.split('-');
    expect(groups).toHaveLength(14);
    for (const group of groups) {
      expect(group).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
    }
    expect(code.replace(/-/g, '')).toHaveLength(56);
  });

  it('never emits the confusable characters O, I, L, or U', async () => {
    for (let i = 0; i < 10; i++) {
      const code = await encodeRecoveryCode(generateMasterKey());
      expect(code).not.toMatch(/[OILU]/);
    }
  });

  it('rejects keys that are not 32 bytes', async () => {
    await expect(encodeRecoveryCode(new Uint8Array(16))).rejects.toThrow(
      /32 bytes/,
    );
  });
});

describe('normalizeRecoveryCode', () => {
  it('uppercases and strips dashes and whitespace', () => {
    expect(normalizeRecoveryCode(' ab-cd\tef\n01 ')).toBe('ABCDEF01');
  });

  it('maps the Crockford confusables O→0 and I/L→1', () => {
    expect(normalizeRecoveryCode('oO')).toBe('00');
    expect(normalizeRecoveryCode('iIlL')).toBe('1111');
  });

  it('leaves genuinely invalid characters (e.g. U) for decode to reject', () => {
    expect(normalizeRecoveryCode('uU')).toBe('UU');
  });
});

describe('decodeRecoveryCode', () => {
  it('roundtrips random keys through the canonical grouped form', async () => {
    for (let i = 0; i < 20; i++) {
      const key = generateMasterKey();
      const result = await decodeRecoveryCode(await encodeRecoveryCode(key));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Buffer.from(result.key).equals(Buffer.from(key))).toBe(true);
      }
    }
  });

  it('decodes the pinned fixed vector back to the fixed key', async () => {
    const result = await decodeRecoveryCode(FIXED_CODE);
    expect(result).toEqual({ ok: true, key: fixedKey() });
  });

  it('accepts lowercase, arbitrary whitespace, and missing dashes', async () => {
    const mangled = FIXED_CODE.toLowerCase().replace(/-/g, ' \n ');
    await expect(decodeRecoveryCode(mangled)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('accepts O/I/L confusables typed in place of 0 and 1', async () => {
    // The fixed vector contains both 0s and 1s; swap a few for confusables.
    const confused = FIXED_CODE.replace('0', 'O')
      .replace('0', 'o')
      .replace('1', 'l')
      .replace('1', 'I');
    expect(confused).not.toBe(FIXED_CODE);
    const result = await decodeRecoveryCode(confused);
    expect(result).toEqual({ ok: true, key: fixedKey() });
  });

  it.each([
    ['empty string', ''],
    ['too short', FIXED_CODE.slice(0, -5)],
    ['too long', `${FIXED_CODE}-AAAA`],
    ['invalid character U', FIXED_CODE.replace('0', 'U')],
    ['non-alphanumeric junk', FIXED_CODE.replace('0', '!')],
  ])('returns a format error for %s', async (_label, input) => {
    await expect(decodeRecoveryCode(input)).resolves.toEqual({
      ok: false,
      error: 'format',
    });
  });

  it('returns a checksum error for well-formed codes with a wrong checksum', async () => {
    const raw = FIXED_CODE.replace(/-/g, '');
    const lastChar = raw[55];
    const substitute = ALPHABET[(ALPHABET.indexOf(lastChar) + 1) % 32];
    const result = await decodeRecoveryCode(raw.slice(0, 55) + substitute);
    expect(result).toEqual({ ok: false, error: 'checksum' });
  });

  it('rejects every single-character substitution of the fixed vector', async () => {
    const raw = FIXED_CODE.replace(/-/g, '');
    for (let i = 0; i < raw.length; i++) {
      for (const char of ALPHABET) {
        if (char === raw[i]) continue;
        const mutated = raw.slice(0, i) + char + raw.slice(i + 1);
        const result = await decodeRecoveryCode(mutated);
        expect(
          result.ok,
          `substitution ${raw[i]}→${char} at position ${i} was accepted`,
        ).toBe(false);
      }
    }
  });

  it('rejects every adjacent transposition of the fixed vector', async () => {
    const raw = FIXED_CODE.replace(/-/g, '');
    for (let i = 0; i < raw.length - 1; i++) {
      if (raw[i] === raw[i + 1]) continue;
      const mutated = raw.slice(0, i) + raw[i + 1] + raw[i] + raw.slice(i + 2);
      const result = await decodeRecoveryCode(mutated);
      expect(
        result.ok,
        `transposition at positions ${i}/${i + 1} was accepted`,
      ).toBe(false);
    }
  });
});
