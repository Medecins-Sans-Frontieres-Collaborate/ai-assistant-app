import { isAllowedDownloadUrl } from '@/lib/services/m365/agentIndexService';

import { describe, expect, it } from 'vitest';

describe('isAllowedDownloadUrl', () => {
  it('accepts Microsoft file-content hosts over https', () => {
    expect(
      isAllowedDownloadUrl(
        'https://contoso-my.sharepoint.com/personal/x/_layouts/15/download.aspx?UniqueId=1',
      ),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl('https://contoso.sharepoint.com/sites/hr/doc.pdf'),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl(
        'https://graph.microsoft.com/v1.0/drives/d/items/i/content',
      ),
    ).toBe(true);
  });

  it('refuses anything else — the caller falls back to /content', () => {
    expect(isAllowedDownloadUrl('http://contoso.sharepoint.com/doc.pdf')).toBe(
      false,
    );
    expect(isAllowedDownloadUrl('https://evil.example.com/doc.pdf')).toBe(
      false,
    );
    expect(isAllowedDownloadUrl('https://sharepoint.com.evil.example/x')).toBe(
      false,
    );
    expect(
      isAllowedDownloadUrl('https://169.254.169.254/latest/meta-data'),
    ).toBe(false);
    expect(isAllowedDownloadUrl('not a url')).toBe(false);
  });
});
