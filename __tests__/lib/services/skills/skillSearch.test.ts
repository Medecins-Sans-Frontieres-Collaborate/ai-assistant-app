import {
  skillIndexDefinition,
  skillSearchFilter,
} from '@/lib/services/skills/skillSearch';

import { describe, expect, it } from 'vitest';

describe('skill search scope', () => {
  const ready = {
    fileId: '11111111-1111-1111-1111-111111111111',
    filename: 'policy.pdf',
    sizeBytes: 100,
    indexStatus: 'indexed' as const,
    nextChunk: 1,
  };
  it('filters by both skill and ready document ids', () => {
    const filter = skillSearchFilter('gdpr', [
      ready,
      {
        ...ready,
        fileId: '22222222-2222-2222-2222-222222222222',
        indexStatus: 'pending',
      },
    ]);
    expect(filter).toContain("skill_id eq 'gdpr'");
    expect(filter).toContain(ready.fileId);
    expect(filter).not.toContain('22222222');
    expect(skillSearchFilter('gdpr', [])).toBeNull();
  });
  it('rejects injected skill ids', () => {
    expect(() => skillSearchFilter("x' or true", [ready])).toThrow();
  });
  it('provisions the dimensions and filter fields used by ingestion and querying', () => {
    const definition = skillIndexDefinition();
    for (const name of ['skill_id', 'file_id'])
      expect(
        definition.fields.find((field) => field.name === name),
      ).toMatchObject({ filterable: true });
    expect(
      definition.fields.find((field) => field.name === 'text_vector'),
    ).toMatchObject({ vectorSearchDimensions: 1536 });
  });
});
