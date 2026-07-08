/**
 * Stage 3: generate a 0-5 rubric per criterion, calibrated against vendor answers.
 */
import { llmJson, pLimit } from '../client';
import type { CriteriaSpec, Criterion } from '../criteria';
import { allCriteria } from '../criteria';
import type { ProgressEmitter } from '../progress';
import type { Responses } from './extractResponses';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { AzureOpenAI } from 'openai';
import { dirname } from 'path';

export interface RubricEntry {
  category: string;
  criterion: string;
  questions: string[];
  weight: number;
  audience: string | null;
  levels: Record<string, string>;
}
export type Rubrics = Record<string, RubricEntry>;

const SYSTEM =
  'You build evaluation rubrics for an RFP scoring exercise. For one specific scoring ' +
  'criterion you will produce a 0-5 rubric. Levels must be evidence-anchored (what the ' +
  'vendor concretely showed), not vibes-based. Calibrate against the sample vendor ' +
  'answers supplied so that strong, real-world answers can earn a 5 and weak answers ' +
  'earn 1-2.\n\n' +
  'Format (strict JSON): {"levels": {"0": "...", "1": "...", "2": "...", ' +
  '"3": "...", "4": "...", "5": "..."}}.\n\n' +
  'Guidance:\n' +
  '- 5 = Excellent / strong quantitative or verifiable evidence.\n' +
  '- 4 = Strong; some indicators but limited transparency or one missing aspect.\n' +
  '- 3 = Adequate; mostly qualitative claims, hard to verify.\n' +
  '- 2 = Concern; very limited info or material gaps.\n' +
  '- 1 = High concern / minimal substantive response.\n' +
  '- 0 = N/A or no response provided.\n\n' +
  'Hard requirements:\n' +
  '- Levels 4 and 5 MUST name the concrete, verifiable evidence required to earn them. ' +
  'Match the evidence type to the criterion: for quantitative criteria (pricing, ' +
  'budgets, performance metrics) demand explicit dollar amounts, rates, or figures; ' +
  'for qualitative criteria (approach, process, strategy) demand specificity — named ' +
  'examples, clients, tools, or measurable outcomes.\n' +
  "- For quantitative criteria, levels 1-2 MUST explicitly cover the 'verbose but " +
  "unsubstantiated' case: an articulate answer with no concrete figures belongs at " +
  '1-2, not 3-4. For qualitative criteria, a complete and credible answer must be ' +
  'able to earn a 3 without hard numbers; reserve 1-2 for thin or generic responses.';

function gatherSamples(
  crit: Criterion,
  responses: Responses,
): Record<string, string> {
  const samples: Record<string, string> = {};
  for (const [vendor, vdata] of Object.entries(responses)) {
    const parts: string[] = [];
    for (const q of crit.questions) {
      const ans = (vdata[q]?.answer || '').trim();
      if (ans) parts.push(`[Q${q}] ${ans}`);
    }
    samples[vendor] = parts.length ? parts.join('\n\n') : '[no response found]';
  }
  return samples;
}

function buildUser(
  crit: Criterion,
  spec: CriteriaSpec,
  samples: Record<string, string>,
): string {
  const qList = crit.questions
    .map((q) => `Q${q}. ${spec.questions[q]}`)
    .join('\n');
  const sampleBlock = Object.entries(samples)
    .map(([vendor, txt]) => `--- ${vendor} ---\n${txt.slice(0, 3000)}`)
    .join('\n\n');
  const audienceNote = crit.audience
    ? `\nIMPORTANT: this criterion only evaluates the vendor's treatment of ` +
      `"${crit.audience}". Tune the rubric so high scores require evidence ` +
      `specifically for this segment.\n`
    : '';
  const desc = crit.description
    ? `\nCriterion intent: ${crit.description}`
    : '';
  return (
    `Criterion: ${crit.name}${desc}\n` +
    `Tied to questions:\n${qList}\n${audienceNote}\n` +
    `=== Sample vendor answers for these questions ===\n${sampleBlock}\n\n` +
    'Generate the 0-5 rubric. Return ONLY the JSON object.'
  );
}

async function makeRubric(
  client: AzureOpenAI,
  crit: Criterion,
  spec: CriteriaSpec,
  responses: Responses,
): Promise<Record<string, string>> {
  const result = await llmJson(
    client,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: buildUser(crit, spec, gatherSamples(crit, responses)),
      },
    ],
    { maxTokens: 1500 },
  );
  const levels = (result.levels as Record<string, string>) || {};
  const out: Record<string, string> = {};
  for (let i = 0; i <= 5; i++) out[String(i)] = levels[String(i)] || '';
  return out;
}

export async function run(params: {
  client: AzureOpenAI;
  spec: CriteriaSpec;
  responsesPath: string;
  cachePath: string;
  progress: ProgressEmitter;
  maxWorkers?: number;
}): Promise<Rubrics> {
  const {
    client,
    spec,
    responsesPath,
    cachePath,
    progress,
    maxWorkers = 4,
  } = params;
  const responses: Responses = JSON.parse(readFileSync(responsesPath, 'utf-8'));
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  const rubrics: Rubrics = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, 'utf-8'))
    : {};

  type Job = [string, number, number, Criterion];
  const jobs: Job[] = [];
  for (const [ci, cj, crit] of allCriteria(spec)) {
    const key = `${ci}_${cj}`;
    if (rubrics[key]?.levels?.['5']) continue;
    jobs.push([key, ci, cj, crit]);
  }

  progress.stageStart('generate_rubrics', jobs.length || 1);
  const flush = () =>
    writeFileSync(cachePath, JSON.stringify(rubrics, null, 2));
  if (!jobs.length) {
    console.log('  (all rubrics cached)');
    progress.stageDone('generate_rubrics');
    return rubrics;
  }
  console.log(`  ${jobs.length} rubrics × ${maxWorkers} workers`);

  const work = async ([key, ci, , crit]: Job): Promise<void> => {
    const levels = await makeRubric(client, crit, spec, responses);
    rubrics[key] = {
      category: spec.categories[ci].name,
      criterion: crit.name,
      questions: crit.questions,
      weight: crit.weight,
      audience: crit.audience,
      levels,
    };
  };

  const limit = pLimit(maxWorkers);
  let completed = 0;
  await Promise.all(
    jobs.map((job) =>
      limit(async () => {
        try {
          await work(job);
          console.log(`  ✓ ${job[0]} ${job[3].name.slice(0, 60)}`);
        } catch (e) {
          console.log(`  ✗ ${job[0]}: ${e}`);
        }
        completed += 1;
        progress.tick(completed);
        if (completed % 5 === 0) flush();
      }),
    ),
  );

  // Serial retry pass: a missing rubric means the criterion never gets scored
  let failed = jobs.filter(([key]) => !rubrics[key]);
  for (let round = 1; round <= 2 && failed.length; round++) {
    console.log(
      `  retrying ${failed.length} failed rubrics serially (round ${round})`,
    );
    const still: Job[] = [];
    for (const job of failed) {
      try {
        await work(job);
        console.log(`  ✓ retry ${job[0]} ${job[3].name.slice(0, 60)}`);
      } catch (e) {
        console.log(`  ✗ retry ${job[0]}: ${e}`);
        still.push(job);
      }
    }
    failed = still;
    flush();
  }
  if (failed.length) {
    console.log(
      `  !! ${failed.length} rubrics permanently missing: ${failed.map((j) => j[0]).join(', ')}`,
    );
  }

  flush();
  progress.stageDone('generate_rubrics');
  return rubrics;
}
