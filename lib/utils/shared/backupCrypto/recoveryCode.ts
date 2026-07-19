/**
 * Recovery-code encoding for the E2E-encrypted chat backup master key.
 *
 * The master key is 256 random bits the server never sees. Its human-facing
 * form is Crockford Base32 (alphabet excludes I, L, O, U to avoid confusable
 * characters): 52 data chars (256 key bits + 4 zero pad bits) followed by a
 * 4-char checksum (first 20 bits of SHA-256 of the raw key), displayed as
 * 14 dash-separated groups of 4 (e.g. `Q7F3-M2A9-…`).
 *
 * The checksum exists purely for local typo feedback — it lets the UI reject
 * a mistyped code before any network call or decrypt attempt. It adds no
 * security: the key itself is full-entropy.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const KEY_BYTES = 32;
const DATA_CHARS = 52; // ceil(256 / 5)
const CHECKSUM_CHARS = 4; // first 20 bits of SHA-256(key)
const CODE_CHARS = DATA_CHARS + CHECKSUM_CHARS;
const GROUP_SIZE = 4;

export type DecodeRecoveryCodeResult =
  | { ok: true; key: Uint8Array }
  | { ok: false; error: 'format' | 'checksum' };

/** Fresh random 256-bit backup master key. */
export function generateMasterKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/** Big-endian bit-packing: emit `charCount` 5-bit Base32 chars, zero-padded. */
function encodeBase32(bytes: Uint8Array, charCount: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  let index = 0;
  while (out.length < charCount) {
    if (bits < 5) {
      buffer = (buffer << 8) | (bytes[index++] ?? 0);
      bits += 8;
    }
    bits -= 5;
    out += ALPHABET[(buffer >> bits) & 31];
  }
  return out;
}

/**
 * Inverse of {@link encodeBase32}. Returns null on invalid chars or when the
 * trailing pad bits are nonzero (a corrupted final data character).
 */
function decodeBase32(chars: string, byteCount: number): Uint8Array | null {
  const out = new Uint8Array(byteCount);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of chars) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (index < byteCount) out[index++] = (buffer >> bits) & 0xff;
    }
  }
  if (index !== byteCount) return null;
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

async function computeChecksumChars(key: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    // Copy: callers may hand us a view over a SharedArrayBuffer-typed buffer,
    // which TS (correctly) refuses to pass to WebCrypto.
    await crypto.subtle.digest('SHA-256', new Uint8Array(key)),
  );
  // 4 chars × 5 bits = the first 20 bits of the digest.
  return encodeBase32(digest, CHECKSUM_CHARS);
}

/** Canonical display form: 56 chars as 14 dash-separated groups of 4. */
export async function encodeRecoveryCode(key: Uint8Array): Promise<string> {
  if (key.length !== KEY_BYTES) {
    throw new Error(`master key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const raw = encodeBase32(key, DATA_CHARS) + (await computeChecksumChars(key));
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP_SIZE) {
    groups.push(raw.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * User-input cleanup: uppercase, drop dashes/whitespace, map the confusables
 * Crockford excludes from the alphabet (O→0, I/L→1). Other invalid characters
 * (e.g. U) are left for decode to reject as a format error.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * Normalizes and validates a typed/pasted code. `'format'` means it cannot be
 * a recovery code at all (wrong length / invalid characters); `'checksum'`
 * means it is well-formed but contains a typo.
 */
export async function decodeRecoveryCode(
  input: string,
): Promise<DecodeRecoveryCodeResult> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== CODE_CHARS) return { ok: false, error: 'format' };

  const key = decodeBase32(normalized.slice(0, DATA_CHARS), KEY_BYTES);
  if (key === null) {
    // Distinguish invalid characters (format) from corrupted pad bits, which
    // read as a typo in the final data character (checksum).
    const allValid = [...normalized].every((c) => ALPHABET.includes(c));
    return { ok: false, error: allValid ? 'checksum' : 'format' };
  }
  if (![...normalized.slice(DATA_CHARS)].every((c) => ALPHABET.includes(c))) {
    return { ok: false, error: 'format' };
  }

  const expected = await computeChecksumChars(key);
  if (normalized.slice(DATA_CHARS) !== expected) {
    return { ok: false, error: 'checksum' };
  }
  return { ok: true, key };
}
