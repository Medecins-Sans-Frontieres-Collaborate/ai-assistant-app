import {
  decodeGraphPageToken,
  encodeGraphNextLink,
} from '@/lib/services/m365/graphPageToken';

import { describe, expect, it } from 'vitest';

const NEXT_LINK =
  'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc123&$top=50';

describe('graphPageToken', () => {
  it('round-trips a valid Graph nextLink', () => {
    const token = encodeGraphNextLink(NEXT_LINK);
    expect(token).toBeDefined();
    // Opaque to clients: the raw URL must not appear in the token.
    expect(token).not.toContain('graph.microsoft.com');
    expect(decodeGraphPageToken(token!)).toBe(NEXT_LINK);
  });

  it('rejects a wrong host in both directions', () => {
    const link = 'https://evil.example.com/v1.0/me/drive/root/children';
    expect(encodeGraphNextLink(link)).toBeUndefined();
    const forged = Buffer.from(link, 'utf8').toString('base64url');
    expect(decodeGraphPageToken(forged)).toBeNull();
  });

  it('rejects a graph.microsoft.com subdomain lookalike', () => {
    const link = 'https://graph.microsoft.com.evil.example/v1.0/me/messages';
    expect(encodeGraphNextLink(link)).toBeUndefined();
    const forged = Buffer.from(link, 'utf8').toString('base64url');
    expect(decodeGraphPageToken(forged)).toBeNull();
  });

  it('rejects http in both directions', () => {
    const link = 'http://graph.microsoft.com/v1.0/me/messages';
    expect(encodeGraphNextLink(link)).toBeUndefined();
    const forged = Buffer.from(link, 'utf8').toString('base64url');
    expect(decodeGraphPageToken(forged)).toBeNull();
  });

  it('rejects paths outside /v1.0/ in both directions', () => {
    for (const link of [
      'https://graph.microsoft.com/beta/me/messages',
      'https://graph.microsoft.com/v1.0x/me/messages',
      'https://graph.microsoft.com/',
    ]) {
      expect(encodeGraphNextLink(link)).toBeUndefined();
      const forged = Buffer.from(link, 'utf8').toString('base64url');
      expect(decodeGraphPageToken(forged)).toBeNull();
    }
  });

  it('rejects oversize input on both encode and decode', () => {
    const longLink = `${NEXT_LINK}&pad=${'x'.repeat(7000)}`;
    expect(encodeGraphNextLink(longLink)).toBeUndefined();
    expect(decodeGraphPageToken('A'.repeat(6145))).toBeNull();
  });

  it('rejects garbage base64 and empty tokens', () => {
    expect(decodeGraphPageToken('!!!not base64url###')).toBeNull();
    expect(decodeGraphPageToken('aHR0cHM6Ly=')).toBeNull(); // padding chars are not base64url
    expect(decodeGraphPageToken('')).toBeNull();
    // Valid base64url that decodes to a non-URL.
    const notAUrl = Buffer.from('hello world', 'utf8').toString('base64url');
    expect(decodeGraphPageToken(notAUrl)).toBeNull();
  });
});
