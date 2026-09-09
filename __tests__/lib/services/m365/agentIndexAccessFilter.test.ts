/**
 * The layer-2 access filter IS the enforcement boundary on the shared
 * m365-agents index: file sources trim by source_id, folder sources trim
 * PER CHILD FILE by item_id, and no clause means no read.
 */
import type { M365Agent } from '@/lib/services/agentAccess/types';
import {
  buildM365AccessFilter,
  sanitizeGraphId,
} from '@/lib/services/m365/agentIndexService';

import { describe, expect, it, vi } from 'vitest';

// agentIndexService transitively imports @/auth (next-auth), which cannot
// resolve in the node test environment — mock it out; the filter builder
// is pure.
vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

function makeAgent(
  sources: Array<{ sourceId: string; kind: 'file' | 'folder' }>,
  id = 'm365-abcdefabcdef',
): M365Agent {
  return {
    version: 1,
    id,
    name: 'Agent',
    description: '',
    systemPrompt: '',
    chatModelId: null,
    embeddingModelId: 'text-embedding',
    ragConfig: { topK: 10 },
    sources: sources.map((s, i) => ({
      sourceId: s.sourceId,
      driveId: 'drive1',
      itemId: `item${i}`,
      kind: s.kind,
      title: `Doc ${i}`,
      webUrl: '',
      status: 'indexed' as const,
    })),
    createdBy: 'a@x.org',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedBy: 'a@x.org',
    updatedAt: '2026-07-29T00:00:00.000Z',
  } as M365Agent;
}

describe('buildM365AccessFilter', () => {
  it('returns null when no sources are accessible', () => {
    const agent = makeAgent([{ sourceId: 'src-1', kind: 'file' }]);
    expect(buildM365AccessFilter(agent, [], [])).toBeNull();
  });

  it('trims file sources by source_id', () => {
    const agent = makeAgent([
      { sourceId: 'src-1', kind: 'file' },
      { sourceId: 'src-2', kind: 'file' },
    ]);
    expect(buildM365AccessFilter(agent, ['src-1'], [])).toBe(
      "agent_id eq 'm365-abcdefabcdef' and (search.in(source_id, 'src-1', ','))",
    );
  });

  it('trims folder sources per child item, never by the folder source id', () => {
    const agent = makeAgent([{ sourceId: 'src-folder', kind: 'folder' }]);
    const filter = buildM365AccessFilter(
      agent,
      ['src-folder'],
      [
        { driveId: 'drive1', itemId: 'childA' },
        { driveId: 'drive1', itemId: 'childB' },
      ],
    );
    expect(filter).toBe(
      "agent_id eq 'm365-abcdefabcdef' and ((drive_id eq 'drive1' and search.in(item_id, 'childA,childB', ',')) or (drive_id eq null and search.in(item_id, 'childA,childB', ',')))",
    );
    expect(filter).not.toContain('src-folder');
  });

  it('keeps same-named items from different drives apart', () => {
    const agent = makeAgent([
      { sourceId: 'src-a', kind: 'folder' },
      { sourceId: 'src-b', kind: 'folder' },
    ]);
    const filter = buildM365AccessFilter(
      agent,
      ['src-a', 'src-b'],
      [
        { driveId: 'driveA', itemId: 'shared' },
        { driveId: 'driveB', itemId: 'other' },
      ],
    );
    // A chunk of item "shared" in driveB is NOT matched by driveA's clause.
    expect(filter).toContain(
      "(drive_id eq 'driveA' and search.in(item_id, 'shared', ','))",
    );
    expect(filter).toContain(
      "(drive_id eq 'driveB' and search.in(item_id, 'other', ','))",
    );
    expect(filter).not.toContain(
      "drive_id eq 'driveB' and search.in(item_id, 'shared",
    );
  });

  it('returns null for an accessible folder with no visible children', () => {
    const agent = makeAgent([{ sourceId: 'src-folder', kind: 'folder' }]);
    expect(buildM365AccessFilter(agent, ['src-folder'], [])).toBeNull();
  });

  it('combines file and folder clauses with or', () => {
    const agent = makeAgent([
      { sourceId: 'src-file', kind: 'file' },
      { sourceId: 'src-folder', kind: 'folder' },
    ]);
    expect(
      buildM365AccessFilter(
        agent,
        ['src-file', 'src-folder'],
        [{ driveId: 'drive1', itemId: 'childA' }],
      ),
    ).toBe(
      "agent_id eq 'm365-abcdefabcdef' and (search.in(source_id, 'src-file', ',') or (drive_id eq 'drive1' and search.in(item_id, 'childA', ',')) or (drive_id eq null and search.in(item_id, 'childA', ',')))",
    );
  });

  it('escapes quotes in the agent id and sanitizes item ids', () => {
    const agent = makeAgent(
      [{ sourceId: 'src-folder', kind: 'folder' }],
      "m365-x' or agent_id ne '",
    );
    const filter = buildM365AccessFilter(
      agent,
      ['src-folder'],
      [{ driveId: "b!dr'ive,1", itemId: "child'1!AB,CD" }],
    );
    expect(filter).toBe(
      "agent_id eq 'm365-x'' or agent_id ne ''' and ((drive_id eq 'bdrive1' and search.in(item_id, 'child1ABCD', ',')) or (drive_id eq null and search.in(item_id, 'child1ABCD', ',')))",
    );
  });
});

describe('sanitizeGraphId', () => {
  it('keeps the drive-item id alphabet and strips delimiters/quotes', () => {
    expect(sanitizeGraphId('01BYE5RZ56Y2GOVW7725BZO354PWSELRRZ')).toBe(
      '01BYE5RZ56Y2GOVW7725BZO354PWSELRRZ',
    );
    expect(sanitizeGraphId("a!b'c,d=e-f_g")).toBe('abcd=e-f_g');
  });
});
