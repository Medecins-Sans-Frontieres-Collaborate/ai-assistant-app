import { NextRequest } from 'next/server';

import {
  M365Error,
  isValidGraphId,
  mintGraphToken,
  normalizeDriveItem,
  normalizeMailEnvelope,
} from '@/lib/services/m365/graphApi';
import { formatMailRecipient } from '@/lib/services/m365/mailMarkdown';

import { getGraphAccessToken } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

const req = new NextRequest('http://localhost/api/m365/test');

describe('mintGraphToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the token when minting succeeds', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: 'tok',
      grantedScopes: ['Mail.Read'],
    });
    await expect(mintGraphToken(req, ['Mail.Read'])).resolves.toBe('tok');
  });

  it('maps AADSTS65001 to consent_missing', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: null,
      grantedScopes: [],
      error: 'AADSTS65001: The user or administrator has not consented…',
    });
    await expect(mintGraphToken(req, ['Mail.Read'])).rejects.toMatchObject({
      kind: 'consent_missing',
      status: 403,
    });
  });

  it('maps a missing refresh token to not_connected', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: null,
      grantedScopes: [],
      error: 'No refresh token available',
    });
    await expect(mintGraphToken(req, ['Mail.Read'])).rejects.toMatchObject({
      kind: 'not_connected',
      status: 401,
    });
  });

  it('maps other failures to graph_error', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: null,
      grantedScopes: [],
      error: 'boom',
    });
    const rejection = mintGraphToken(req, ['Mail.Read']);
    await expect(rejection).rejects.toBeInstanceOf(M365Error);
    await expect(rejection).rejects.toMatchObject({ kind: 'graph_error' });
  });
});

describe('isValidGraphId', () => {
  it('accepts typical Graph ids and rejects path-altering input', () => {
    expect(isValidGraphId('01ABCDEF!123')).toBe(true);
    expect(isValidGraphId('AAMkAGX2Y_z=')).toBe(true);
    expect(isValidGraphId('a/b')).toBe(false);
    expect(isValidGraphId('a?b=c')).toBe(false);
    expect(isValidGraphId('')).toBe(false);
    expect(isValidGraphId(undefined)).toBe(false);
  });
});

describe('normalizeDriveItem', () => {
  it('derives sourceLabel from webUrl (site slug / OneDrive / host)', () => {
    const base = {
      id: 'i1',
      name: 'handbook.docx',
      parentReference: { driveId: 'd1' },
    };
    expect(
      normalizeDriveItem({
        ...base,
        webUrl:
          'https://msfusa.sharepoint.com/sites/HR/Shared%20Documents/handbook.docx',
      } as never)?.sourceLabel,
    ).toBe('HR');
    expect(
      normalizeDriveItem({
        ...base,
        webUrl:
          'https://msfusa-my.sharepoint.com/personal/blaze_msf_org/Documents/handbook.docx',
      } as never)?.sourceLabel,
    ).toBe('OneDrive');
    expect(
      normalizeDriveItem({
        ...base,
        webUrl:
          'https://msfes.sharepoint.com/teams/Logistica/Docs/handbook.docx',
      } as never)?.sourceLabel,
    ).toBe('Logistica');
    expect(
      normalizeDriveItem({ ...base } as never)?.sourceLabel,
    ).toBeUndefined();
  });

  it('normalizes an ordinary item', () => {
    expect(
      normalizeDriveItem({
        id: 'item1',
        name: 'report.docx',
        size: 1234,
        webUrl: 'https://contoso.sharepoint.com/report.docx',
        lastModifiedDateTime: '2026-07-01T00:00:00Z',
        file: { mimeType: 'application/vnd.openxmlformats' },
        parentReference: { driveId: 'drive1' },
      }),
    ).toEqual({
      driveId: 'drive1',
      itemId: 'item1',
      name: 'report.docx',
      isFolder: false,
      size: 1234,
      mimeType: 'application/vnd.openxmlformats',
      webUrl: 'https://contoso.sharepoint.com/report.docx',
      sourceLabel: 'contoso',
      lastModified: '2026-07-01T00:00:00Z',
    });
  });

  it('prefers remoteItem for shared-with-me entries', () => {
    const entry = normalizeDriveItem({
      id: 'outer',
      name: 'shared.xlsx',
      remoteItem: {
        id: 'remote1',
        name: 'shared.xlsx',
        parentReference: { driveId: 'remoteDrive' },
        folder: { childCount: 3 },
      },
    });
    expect(entry).toMatchObject({
      driveId: 'remoteDrive',
      itemId: 'remote1',
      isFolder: true,
      childCount: 3,
    });
  });

  it('returns null when the drive id is missing', () => {
    expect(normalizeDriveItem({ id: 'x', name: 'y' })).toBeNull();
    expect(normalizeDriveItem(null)).toBeNull();
  });
});

describe('mail normalization', () => {
  it('formats recipients with and without display names', () => {
    expect(
      formatMailRecipient({
        emailAddress: { name: 'Maria', address: 'maria@x.org' },
      }),
    ).toBe('Maria <maria@x.org>');
    expect(
      formatMailRecipient({ emailAddress: { address: 'maria@x.org' } }),
    ).toBe('maria@x.org');
    expect(formatMailRecipient(undefined)).toBe('');
  });

  it('normalizes an envelope with a subject fallback', () => {
    expect(
      normalizeMailEnvelope({
        id: 'm1',
        conversationId: 'c1',
        subject: '',
        bodyPreview: ' preview ',
        hasAttachments: true,
      }),
    ).toEqual({
      id: 'm1',
      conversationId: 'c1',
      subject: '(no subject)',
      from: '',
      preview: 'preview',
      hasAttachments: true,
    });
    expect(normalizeMailEnvelope({})).toBeNull();
  });
});
