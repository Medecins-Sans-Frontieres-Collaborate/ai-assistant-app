import type { EvalCase } from './types';

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'case id must be kebab-case'),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  promptOptions: z
    .object({
      userPrompt: z.string().optional(),
      webSearchActive: z.boolean().optional(),
      codeInterpreterAvailable: z.boolean().optional(),
      conversationSummary: z.string().optional(),
      memories: z.array(z.string()).optional(),
    })
    .optional(),
  rubric: z.string().optional(),
  turns: z
    .array(z.object({ user: z.string().min(1), expect: z.string().optional() }))
    .min(1),
});

export const CASES_DIR = path.resolve(process.cwd(), 'evals/cases');

export function loadCases(filter?: {
  ids?: string[];
  tags?: string[];
}): EvalCase[] {
  const files = fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const cases = files.map((f) => {
    const parsed = caseSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8')),
    );
    if (!parsed.success)
      throw new Error(`Invalid case ${f}: ${parsed.error.message}`);
    return parsed.data as EvalCase;
  });
  const dupes = cases
    .map((c) => c.id)
    .filter((id, i, a) => a.indexOf(id) !== i);
  if (dupes.length) throw new Error(`Duplicate case ids: ${dupes.join(', ')}`);
  return cases.filter(
    (c) =>
      (!filter?.ids?.length || filter.ids.includes(c.id)) &&
      (!filter?.tags?.length || filter.tags.some((t) => c.tags?.includes(t))),
  );
}
