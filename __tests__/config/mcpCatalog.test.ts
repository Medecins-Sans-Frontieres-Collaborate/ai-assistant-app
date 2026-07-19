import { MCP_SERVER_ID_PATTERN } from '@/types/mcp';

import {
  MCP_CATALOG,
  ResolveMcpServersOptions,
  ResolvedMcpServer,
  resolveMcpServers,
} from '@/config/mcpCatalog';
import enMessages from '@/messages/en.json';
import { describe, expect, it, vi } from 'vitest';

const allowAll: ResolveMcpServersOptions = {
  allowCustom: true,
  isAllowedCustomUrl: () => true,
};

describe('MCP_CATALOG', () => {
  it('gives every entry an https URL and complete metadata', () => {
    // Iterate the catalog itself rather than a hardcoded list so a new
    // connector cannot be added without meeting these invariants.
    for (const key of Object.keys(MCP_CATALOG)) {
      const entry = MCP_CATALOG[key];
      expect(entry).toBeDefined();
      expect(entry.key).toBe(key);
      expect(entry.url.startsWith('https://')).toBe(true);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.nameKey).toContain(key);
      // The catalog key doubles as the stored server id, so it must satisfy
      // the id pattern or resolveMcpServers would drop the entry outright.
      expect(MCP_SERVER_ID_PATTERN.test(key)).toBe(true);
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

  it('points the vendor-hosted connectors at their documented endpoints', () => {
    // Hardcoded so a typo or an unreviewed URL swap fails loudly — these are
    // the values the server trusts without any SSRF check.
    expect(MCP_CATALOG.tableau.url).toBe('https://mcp.tableau.com');
    expect(MCP_CATALOG.salesforce.url).toBe(
      'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all',
    );
    expect(MCP_CATALOG.hootsuitePerch.url).toBe(
      'https://mcp.hootsuite.com/perch',
    );
    expect(MCP_CATALOG.hootsuiteNest.url).toBe(
      'https://mcp.hootsuite.com/nest',
    );
    for (const key of [
      'tableau',
      'salesforce',
      'hootsuitePerch',
      'hootsuiteNest',
    ]) {
      expect(MCP_CATALOG[key].auth.style).toBe('oauth');
    }
  });

  it('has an en.json name and description for every entry', () => {
    for (const entry of Object.values(MCP_CATALOG)) {
      for (const key of [entry.nameKey, entry.descriptionKey]) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, segment) =>
              typeof node === 'object' && node !== null
                ? (node as Record<string, unknown>)[segment]
                : undefined,
            enMessages,
          );
        expect(typeof value, `missing i18n key ${key}`).toBe('string');
      }
    }
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

describe('resolveMcpServers — admin connectors', () => {
  const connector: ResolvedMcpServer = {
    id: 'connector-abc123def456',
    label: 'Contoso NetSuite',
    url: 'https://acct123.suitetalk.api.netsuite.com/services/mcp/v1/all',
    transport: 'streamable-http',
    auth: { style: 'bearer' },
    trusted: true,
  };

  const withConnector = (
    resolveConnector: (id: string) => ResolvedMcpServer | null,
  ): ResolveMcpServersOptions => ({
    allowCustom: true,
    isAllowedCustomUrl: () => true,
    resolveConnector,
  });

  it('resolves a permitted connector and IGNORES a client-sent url', () => {
    const resolved = resolveMcpServers(
      [
        {
          id: 'c1',
          name: 'Totally NetSuite',
          connectorId: 'connector-abc123def456',
          // A tampered localStorage blob trying to redirect the token:
          url: 'https://attacker.example.com/mcp',
          authToken: 'user-token',
        },
      ],
      withConnector(() => connector),
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].url).toBe(connector.url);
    expect(resolved[0].label).toBe('Contoso NetSuite');
    expect(resolved[0].trusted).toBe(true);
    expect(resolved[0].authToken).toBe('user-token');
    // The client's own entry id is preserved — it prefixes tool names.
    expect(resolved[0].id).toBe('c1');
  });

  it('drops a connector the resolver denies, even when a url is supplied', () => {
    // The security property: a stale settings blob for a connector this user
    // is no longer entitled to must not fall through to the custom-URL path.
    const resolved = resolveMcpServers(
      [
        {
          id: 'c1',
          name: 'Revoked',
          connectorId: 'connector-abc123def456',
          url: 'https://attacker.example.com/mcp',
          authToken: 'user-token',
        },
      ],
      withConnector(() => null),
    );

    expect(resolved).toEqual([]);
  });

  it('drops connectors when no resolver is wired at all', () => {
    // A call site that forgot to pass resolveConnector must fail closed
    // rather than silently reaching the connector URL unchecked.
    const resolved = resolveMcpServers(
      [{ id: 'c1', name: 'X', connectorId: 'connector-abc123def456' }],
      allowAll,
    );

    expect(resolved).toEqual([]);
  });

  it('withholds the credential from a none-style connector', () => {
    const resolved = resolveMcpServers(
      [
        {
          id: 'c1',
          name: 'Anonymous',
          connectorId: 'connector-abc123def456',
          authToken: 'should-not-be-relayed',
        },
      ],
      withConnector(() => ({ ...connector, auth: { style: 'none' } })),
    );

    expect(resolved[0].authToken).toBeUndefined();
  });

  it('prefers the catalog when an entry carries both keys', () => {
    const resolveConnector = vi.fn(() => connector);
    const resolved = resolveMcpServers(
      [
        {
          id: 'c1',
          name: 'Both',
          catalogKey: 'github',
          connectorId: 'connector-abc123def456',
        },
      ],
      withConnector(resolveConnector),
    );

    expect(resolved[0].url).toBe(MCP_CATALOG.github.url);
    expect(resolveConnector).not.toHaveBeenCalled();
  });
});
