/**
 * Stage 4: score each vendor on each criterion, comparatively, with justifications.
 */
import { llmJson, pLimit } from '../client';
import type { CriteriaSpec, Criterion } from '../criteria';
import { allCriteria } from '../criteria';
import type { ProgressEmitter } from '../progress';
import type { Responses } from './extractResponses';
import type { Rubrics } from './generateRubrics';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { AzureOpenAI } from 'openai';
import { dirname } from 'path';

export interface VendorScore {
  score: number;
  why: string;
  deferred?: boolean;
  external_material?: boolean;
}
export interface ScoreEntry {
  category: string;
  criterion: string;
  questions: string[];
  weight: number;
  audience: string | null;
  vendors: Record<string, VendorScore>;
}
export type Scores = Record<string, ScoreEntry>;

const SYSTEM =
  'You are an experienced procurement analyst scoring vendors on one specific RFP ' +
  'criterion. You will be given:\n' +
  '1. The criterion name (and its question source).\n' +
  '2. A 0-5 rubric.\n' +
  '3. The verbatim response from each vendor for the relevant question(s).\n\n' +
  'For each vendor return:\n' +
  '- score: float 0-5 (half-points allowed)\n' +
  '- why: 1-3 sentence justification anchored to specific evidence (or its absence). ' +
  "  Cite numbers, names, programs, or features from the vendor's response when " +
  '  relevant. Avoid generic wording.\n\n' +
  'Scoring discipline (apply strictly):\n' +
  '- ENFORCE THE RUBRIC LITERALLY. Score the level whose description the response ' +
  'actually matches. Where a level explicitly demands concrete evidence (e.g., ' +
  "'specific fees'), verify that evidence is present before awarding it: a pricing " +
  'answer with no dollar amounts cannot earn a level that requires them, no matter ' +
  'how professional the prose is.\n' +
  '- Apply the hard-evidence cap only where the rubric demands it. For inherently ' +
  'quantitative criteria (pricing, budgets, performance metrics), missing numbers cap ' +
  'the score at 1-2. For qualitative criteria (approach, process, strategy, creative ' +
  'philosophy), a complete, credible, and specific answer merits a 3 — a 4 if it is ' +
  'detailed and differentiated. Named clients, examples, tools, or measurable results ' +
  'earn 4.5-5.\n' +
  '- Reserve 1-2 for genuinely thin, evasive, or generic answers.\n' +
  '- Scores of 4.5-5 require strong verifiable evidence, not merely thorough prose.\n' +
  "- When you cap a score for missing evidence, name the missing evidence in 'why'.\n" +
  "- DEFERRED ANSWERS: if a vendor's answer SUBSTANTIALLY defers to an external " +
  'attachment or separate document whose content is NOT included in the provided text ' +
  "(e.g., 'please see the attached pricing document'), do not score it as a weak " +
  'answer. Set score 0, set "deferred": true, and state in \'why\' what the attachment ' +
  'reportedly contains. Deferred items are routed to human review instead of counting ' +
  'against the vendor.\n' +
  "- SUPPLEMENTAL REFERENCES: if a vendor's answer has scoreable substance but ALSO " +
  'references external material (appendix, samples, portfolio links), score the text ' +
  'normally and set "external_material": true so a human can review the material. ' +
  "Apply this consistently: if one vendor's reference earns the flag, every vendor " +
  'with a comparable reference gets it.\n\n' +
  'Return strict JSON: {"scores": [{"vendor": "<name>", "score": <float>, ' +
  '"why": "<text>", "deferred": <true ONLY when the substance lives in an ' +
  'external attachment>, "external_material": <true when the answer references ' +
  'supplemental material>}]}. Include every vendor listed.';

function gatherVendorAnswers(
  crit: Criterion,
  vendors: string[],
  responses: Responses,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vendors) {
    const parts: string[] = [];
    for (const q of crit.questions) {
      const ans = (responses[v]?.[q]?.answer || '').trim();
      if (ans) parts.push(`[Q${q}] ${ans}`);
    }
    out[v] = parts.length ? parts.join('\n\n') : '[no response found]';
  }
  return out;
}

function buildUser(
  crit: Criterion,
  spec: CriteriaSpec,
  rubric: Record<string, string>,
  vendorAnswers: Record<string, string>,
): string {
  const qBlock = crit.questions
    .map((q) => `Q${q}. ${spec.questions[q]}`)
    .join('\n');
  const rubricBlock = Object.entries(rubric)
    .map(([lvl, desc]) => `  ${lvl}: ${desc}`)
    .join('\n');
  const audienceNote = crit.audience
    ? `\nSCOPE: Only evaluate the vendor's treatment of "${crit.audience}". ` +
      'Ignore content about other audiences when scoring this criterion.\n'
    : '';
  const desc = crit.description
    ? `\nCriterion intent: ${crit.description}`
    : '';
  const answersBlock = Object.entries(vendorAnswers)
    .map(([v, a]) => `=== ${v} ===\n${a}`)
    .join('\n\n');
  const n = Object.keys(vendorAnswers).length;
  return (
    `Criterion: ${crit.name}${desc}\n` +
    `Underlying RFP questions:\n${qBlock}\n${audienceNote}\n` +
    `=== 0-5 Rubric ===\n${rubricBlock}\n\n` +
    `=== Vendor Responses ===\n${answersBlock}\n\n` +
    `Score all ${n} vendors. Return JSON only.`
  );
}

async function scoreCriterion(
  client: AzureOpenAI,
  crit: Criterion,
  spec: CriteriaSpec,
  vendors: string[],
  rubricLevels: Record<string, string>,
  responses: Responses,
): Promise<Record<string, VendorScore>> {
  const vendorAnswers = gatherVendorAnswers(crit, vendors, responses);
  const result = await llmJson(
    client,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: buildUser(crit, spec, rubricLevels, vendorAnswers),
      },
    ],
    { maxTokens: 2500 },
  );
  const out: Record<string, VendorScore> = {};
  for (const entry of (result.scores as Array<Record<string, unknown>>) || []) {
    const v = String(entry.vendor || '');
    if (!vendors.includes(v)) continue;
    const s = Number(entry.score) || 0;
    const d: VendorScore = {
      score: Math.max(0, Math.min(5, s)),
      why: String(entry.why || '').trim(),
    };
    if (entry.deferred) d.deferred = true;
    if (entry.external_material) d.external_material = true;
    out[v] = d;
  }
  for (const v of vendors) {
    if (!out[v]) out[v] = { score: 0, why: '[no score returned]' };
  }
  return out;
}

export async function run(params: {
  client: AzureOpenAI;
  spec: CriteriaSpec;
  vendors: string[];
  responsesPath: string;
  rubricsPath: string;
  cachePath: string;
  progress: ProgressEmitter;
  maxWorkers?: number;
}): Promise<Scores> {
  const {
    client,
    spec,
    vendors,
    responsesPath,
    rubricsPath,
    cachePath,
    progress,
    maxWorkers = 4,
  } = params;
  const responses: Responses = JSON.parse(readFileSync(responsesPath, 'utf-8'));
  const rubrics: Rubrics = JSON.parse(readFileSync(rubricsPath, 'utf-8'));
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  const scores: Scores = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, 'utf-8'))
    : {};

  type Job = [string, number, number, Criterion, Record<string, string>];
  const jobs: Job[] = [];
  for (const [ci, cj, crit] of allCriteria(spec)) {
    const key = `${ci}_${cj}`;
    if (scores[key] && vendors.every((v) => scores[key].vendors[v])) continue;
    if (!rubrics[key]) {
      console.log(`  ! no rubric for ${key}; skipping`);
      continue;
    }
    jobs.push([key, ci, cj, crit, rubrics[key].levels]);
  }

  progress.stageStart('score_vendors', jobs.length || 1);
  const flush = () => writeFileSync(cachePath, JSON.stringify(scores, null, 2));
  if (!jobs.length) {
    console.log('  (all scores cached)');
    progress.stageDone('score_vendors');
    return scores;
  }
  console.log(`  ${jobs.length} criteria × ${maxWorkers} workers`);

  const work = async ([key, ci, , crit, rubricLevels]: Job): Promise<void> => {
    const vs = await scoreCriterion(
      client,
      crit,
      spec,
      vendors,
      rubricLevels,
      responses,
    );
    scores[key] = {
      category: spec.categories[ci].name,
      criterion: crit.name,
      questions: crit.questions,
      weight: crit.weight,
      audience: crit.audience,
      vendors: vs,
    };
  };

  const limit = pLimit(maxWorkers);
  let completed = 0;
  await Promise.all(
    jobs.map((job) =>
      limit(async () => {
        try {
          await work(job);
          const line = vendors
            .map((v) => `${v}=${scores[job[0]].vendors[v].score}`)
            .join(' / ');
          console.log(`  ✓ ${job[0]} ${job[3].name.slice(0, 50)} → ${line}`);
        } catch (e) {
          console.log(`  ✗ ${job[0]}: ${e}`);
        }
        completed += 1;
        progress.tick(completed);
        if (completed % 5 === 0) flush();
      }),
    ),
  );

  // Serial retry pass: rate-limited/failed jobs must not silently score 0
  let failed = jobs.filter(([key]) => !scores[key]);
  for (let round = 1; round <= 2 && failed.length; round++) {
    console.log(
      `  retrying ${failed.length} failed criteria serially (round ${round})`,
    );
    const still: Job[] = [];
    for (const job of failed) {
      try {
        await work(job);
        console.log(`  ✓ retry ${job[0]} ${job[3].name.slice(0, 50)}`);
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
      `  !! ${failed.length} criteria permanently unscored: ${failed.map((j) => j[0]).join(', ')}`,
    );
  }

  flush();
  progress.stageDone('score_vendors');
  return scores;
}
