import { buildDataAssessmentSchema } from '@/lib/services/workflows/data/assessSchema';
import {
  buildDataChatSystemPrompt,
  buildDataDigest,
} from '@/lib/services/workflows/data/chatPrompts';
import {
  buildDataAssessmentSystemPrompt,
  buildDataAssessmentUserPrompt,
  buildExtractionUserPrompt,
  buildPhotoExtractUserPrompt,
  buildPhotoInferSystemPrompt,
  buildRequiredFieldsGuidance,
  buildStatsBlock,
  buildTransformSystemPrompt,
  serializeTableWithRids,
} from '@/lib/services/workflows/data/prompts';
import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';

import { ColumnProfile, DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const columns: DataColumn[] = [
  { id: 'region', name: 'Region', type: 'text' },
  { id: 'cases', name: 'Cases', type: 'number' },
];
const rows = [
  { [ROW_ID_KEY]: 'a', region: 'North', cases: 10 },
  { [ROW_ID_KEY]: 'b', region: null, cases: true },
];
const stats: ColumnProfile[] = [
  {
    columnId: 'region',
    total: 2,
    missing: 1,
    distinct: 1,
    topValues: [{ value: 'North', count: 1 }],
  },
  {
    columnId: 'cases',
    total: 2,
    missing: 0,
    distinct: 2,
    min: 10,
    max: 12,
    mean: 11,
    median: 11,
  },
];

describe('serializeTableWithRids', () => {
  it('puts __rid first and renders cells via formatCell', () => {
    const tsv = serializeTableWithRids(columns, rows);
    const lines = tsv.split('\n');
    expect(lines[0]).toBe(`${ROW_ID_KEY}\tregion\tcases`);
    expect(lines[1]).toBe('a\tNorth\t10');
    expect(lines[2]).toBe('b\t\ttrue');
  });
});

describe('buildStatsBlock', () => {
  it('includes missing/distinct, numeric stats, and value counts', () => {
    const block = buildStatsBlock(columns, stats);
    expect(block).toContain('missing 1/2');
    expect(block).toContain('range 10–12');
    expect(block).toContain('median 11');
    expect(block).toContain('"North"×1');
  });
});

describe('transform prompt scoping', () => {
  it('adds subset rules only in scoped mode', () => {
    expect(buildTransformSystemPrompt(false)).not.toContain('SCOPED MODE');
    const scoped = buildTransformSystemPrompt(true);
    expect(scoped).toContain('SCOPED MODE');
    expect(scoped).toContain('same number of rows');
    expect(scoped).toContain('never remove or reorder existing columns');
  });
});

describe('assessment prompts', () => {
  it('system prompt carries the rubrics and the rid/before echo rules', () => {
    const system = buildDataAssessmentSystemPrompt(['Validity: values ok.']);
    expect(system).toContain('Validity: values ok.');
    expect(system).toContain(`Echo the row's ${ROW_ID_KEY} EXACTLY`);
    expect(system).toContain("'before' must reproduce the printed cell value");
  });

  it('user prompt states sampling explicitly', () => {
    const full = buildDataAssessmentUserPrompt({
      columns,
      rows,
      stats,
      totalRowCount: 2,
      sampled: false,
    });
    expect(full).not.toContain('deterministic sample');

    const sampled = buildDataAssessmentUserPrompt({
      columns,
      rows,
      stats,
      totalRowCount: 500,
      sampled: true,
    });
    expect(sampled).toContain('sample of 2 of the 500 rows');
    expect(sampled).toContain('only propose fixes for rows shown here');
  });
});

describe('buildDataAssessmentSchema', () => {
  it('restricts criterion enums to the requested ids', () => {
    const schema = buildDataAssessmentSchema(['validity', 'duplicates']);
    const properties = schema.properties as Record<
      string,
      { items: { properties: Record<string, { enum?: string[] }> } }
    >;
    expect(properties.criteria.items.properties.criterionId.enum).toEqual([
      'validity',
      'duplicates',
    ]);
    expect(properties.edits.items.properties.criterion.enum).toEqual([
      'validity',
      'duplicates',
    ]);
    expect(properties.edits.items.properties.kind.enum).toEqual([
      'cell',
      'deleteRow',
    ]);
  });
});

describe('data chat digest', () => {
  it('contains schema, exact stats, rid column, and sample counts', () => {
    const digest = buildDataDigest({
      columns,
      stats,
      sampleRows: rows,
      totalRowCount: 500,
    });
    expect(digest).toContain('## Table schema');
    expect(digest).toContain('computed exactly over all 500 rows');
    expect(digest).toContain(`first column is ${ROW_ID_KEY}`);
    expect(digest).toContain('a sample of 2 of the 500 rows');
    expect(digest).toContain('Total rows: 500 (sample of 2 shown)');
  });

  it('omits sample framing when all rows are included', () => {
    const digest = buildDataDigest({
      columns,
      stats,
      sampleRows: rows,
      totalRowCount: 2,
    });
    expect(digest).not.toContain('sample of');
    expect(digest).toContain('Total rows: 2');
  });

  it('system prompt is read-only about mutations', () => {
    const system = buildDataChatSystemPrompt();
    expect(system).toContain('you cannot modify the table');
    expect(system).toContain('NEVER claim a change was made');
  });
});

describe('photo prompts', () => {
  it('infer prompt covers record/table decision and exact transcription', () => {
    const system = buildPhotoInferSystemPrompt();
    expect(system).toContain('kind "record"');
    expect(system).toContain('kind "table"');
    expect(system).toContain('never guess');
    expect(system).toContain('ONE unified column set');
  });

  it('extract prompt lists required fields as guidance', () => {
    const required: DataColumn[] = [
      { id: 'name', name: 'Name', type: 'text', required: true },
      { id: 'notes', name: 'Notes', type: 'text' },
    ];
    const prompt = buildPhotoExtractUserPrompt(required);
    // Only the required column appears in the guidance line.
    expect(prompt).toContain('Required fields: "Name" —');
    expect(prompt).toContain('never invent a value');
    expect(prompt).toContain('REQUIRED');
  });

  it('text extraction prompt gains the same required guidance', () => {
    const required: DataColumn[] = [
      { id: 'name', name: 'Name', type: 'text', required: true },
    ];
    const prompt = buildExtractionUserPrompt('material', required);
    expect(prompt).toContain('Required fields: "Name"');
  });

  it('no guidance line without required columns', () => {
    expect(buildRequiredFieldsGuidance(columns)).toBe('');
  });
});
