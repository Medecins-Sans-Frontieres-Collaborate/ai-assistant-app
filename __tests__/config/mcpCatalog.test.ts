import {
  MCP_CATALOG,
  ResolveMcpServersOptions,
  resolveMcpServers,
} from '@/config/mcpCatalog';
import { describe, expect, it } from 'vitest';

const allowAll: ResolveMcpServersOptions = {
  allowCustom: true,
  isAllowedCustomUrl: () => true,
};

describe('MCP_CATALOG', () => {
  it('contains github and asana with https URLs and complete metadata', () => {
    for (const key of ['github', 'asana']) {
      const entry = MCP_CATALOG[key];
      expect(entry).toBeDefined();
      expect(entry.key).toBe(key);
      expect(entry.url.startsWith('https://')).toBe(true);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.nameKey).toContain(key);
      // Token-help metadata only makes sense for pasted-token auth styles;
      // oauth entries (Asana) sign in via the provider instead.
      if (entry.auth.style === 'bearer' || entry.auth.style === 'header') {
        expect(entry.tokenHelpUrl?.startsWith('https://')).toBe(true);
      }
    }
    expect(MCP_CATALOG.github.auth.style).toBe('bearer');
    // GitHub's hosted MCP also accepts OAuth — dual-auth in the UI.
    expect(MCP_CATALOG.github.alsoSupportsOauth).toBe(true);
    expect(MCP_CATALOG.asana.auth.style).toBe('oauth');
  });
});

describe('resolveMcpServers', () => {
  it('resolves curated entries from the catalog and IGNORES a client-sent url (spoof-proofing)', () => {
    const resolved = resolveMcpServers(
      [
        {
          id: 'gh1',
          name: 'Totally GitHub',
          catalogKey: 'github',
          // A tampered localStorage blob trying to redirect the PAT:
          url: 'https://attacker.example.com/mcp',
          authToken: 'github_pat_secret',
        },
      ],
      allowAll,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].url).toBe(MCP_CATALOG.github.url);
    expect(resolved[0].label).toBe('GitHub');
    expect(resolved[0].trusted).toBe(true);
    expect(resolved[0].authToken).toBe('github_pat_secret');
  });

  it('drops entries with unknown catalog keys', () => {
    const resolved = resolveMcpServers(
      [{ id: 'x1', name: 'X', catalogKey: 'not-a-thing' }],
      allowAll,
    );
    expect(resolved).toEqual([]);
  });

  it('drops custom entries entirely when allowCustom is false', () => {
    const resolved = resolveMcpServers(
      [{ id: 'c1', name: 'Mine', url: 'https://mcp.example.com' }],
      { allowCustom: false, isAllowedCustomUrl: () => true },
    );
    expect(resolved).toEqual([]);
  });

  it('keeps custom entries that pass the URL guard, as untrusted', () => {
    const resolved = resolveMcpServers(
      [
        {
          id: 'c1',
          name: 'Mine',
          url: 'https://mcp.example.com',
          authToken: 't',
        },
      ],
      allowAll,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].trusted).toBe(false);
    expect(resolved[0].label).toBe('Mine');
    expect(resolved[0].url).toBe('https://mcp.example.com');
  });

  it('drops custom entries the URL guard rejects', () => {
    const resolved = resolveMcpServers(
      [{ id: 'c1', name: 'Mine', url: 'https://10.0.0.1/mcp' }],
      { allowCustom: true, isAllowedCustomUrl: () => false },
    );
    expect(resolved).toEqual([]);
  });

  it('drops entries with invalid or duplicate ids', () => {
    const resolved = resolveMcpServers(
      [
        { id: 'bad id!', name: 'A', catalogKey: 'github' },
        { id: 'dup', name: 'B', catalogKey: 'github' },
        { id: 'dup', name: 'C', catalogKey: 'asana' },
        { id: 'x'.repeat(65), name: 'D', catalogKey: 'github' },
      ],
      allowAll,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('dup');
    expect(resolved[0].label).toBe('GitHub');
  });

  it('drops custom entries with no url', () => {
    const resolved = resolveMcpServers([{ id: 'c1', name: 'Mine' }], allowAll);
    expect(resolved).toEqual([]);
  });
});
