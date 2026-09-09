/**
 * Entry point — run with `npm run evals` (see evals/README.md for knobs).
 *
 * Uses vitest purely as the TS runner with the repo's path aliases; the
 * single "test" always passes unless the harness itself throws. Pass/fail
 * judgement is for humans reading the report, not CI.
 */
import { loadCases } from './lib/cases';
import { readCachedRun, runCacheKey, writeCachedRun } from './lib/cases-cache';
import { envList, envNumber, envString, loadEvalEnv } from './lib/env';
import { judgeRun } from './lib/judge';
import { getModelMeta } from './lib/models';
import { compareCase, renderMarkdown, summarizeStrategy } from './lib/report';
import { runCase } from './lib/runner';
import type { CaseComparison, EvalReport, RunResult } from './lib/types';
import { STRATEGIES, STRATEGY_VERSION, getStrategy } from './strategies';

import fs from 'fs';
import path from 'path';
import { describe, it } from 'vitest';

loadEvalEnv();

interface PairsFile {
  default: string;
  pairs: Record<string, { goal: string; aspirational: string }>;
}

function resolvePair(): { goal: string; aspirational: string } {
  const file = JSON.parse(
    fs.readFileSync(
      path.resolve(process.cwd(), 'evals/config/pairs.json'),
      'utf8',
    ),
  ) as PairsFile;
  const name = envString('EVAL_PAIR', file.default)!;
  const pair = file.pairs[name];
  if (!pair && !(envString('EVAL_GOAL') && envString('EVAL_ASPIRATIONAL'))) {
    throw new Error(
      `Unknown EVAL_PAIR "${name}". Known: ${Object.keys(file.pairs).join(', ')}`,
    );
  }
  return {
    goal: envString('EVAL_GOAL', pair?.goal)!,
    aspirational: envString('EVAL_ASPIRATIONAL', pair?.aspirational)!,
  };
}

const log = (line: string) => process.stdout.write(`${line}\n`);

describe('model parity', () => {
  it('runs the configured pair through every selected strategy', async () => {
    const { goal, aspirational } = resolvePair();
    const goalStrategyId = envString('EVAL_GOAL_STRATEGY', 'baseline')!;
    const strategyIds = envList(
      'EVAL_STRATEGIES',
      Object.keys(STRATEGIES).filter(
        (id) => id !== goalStrategyId || goal !== aspirational,
      ),
    );
    const judgeModelId = envString('EVAL_JUDGE', goal)!;
    const costCeiling = envNumber('EVAL_COST_CEILING', 0.5);
    const cases = loadCases({
      ids: envList('EVAL_CASES', []),
      tags: envList('EVAL_TAGS', []),
    });
    if (!cases.length)
      throw new Error('No cases matched EVAL_CASES / EVAL_TAGS');
    [goal, aspirational, judgeModelId].forEach(getModelMeta); // fail fast on unknown ids

    log(
      `goal=${goal} aspirational=${aspirational} judge=${judgeModelId} strategies=${strategyIds.join(',')} cases=${cases.length} ceiling=${costCeiling}`,
    );

    const runOrCache = async (
      modelId: string,
      strategyId: string,
      evalCase: (typeof cases)[number],
    ): Promise<RunResult> => {
      const key = runCacheKey(evalCase, modelId, strategyId, STRATEGY_VERSION);
      const cached = readCachedRun(key);
      if (cached) {
        log(`  [${modelId}/${strategyId}] ${evalCase.id} (cached)`);
        return cached;
      }
      const result = await runCase({
        evalCase,
        modelId,
        strategy: getStrategy(strategyId),
        log,
      });
      writeCachedRun(key, result);
      return result;
    };

    // 1. Goal references (cached across runs).
    const references = new Map<string, RunResult>();
    for (const c of cases)
      references.set(c.id, await runOrCache(goal, goalStrategyId, c));

    // 2. Candidates per strategy + judge.
    const summaries = [];
    for (const strategyId of strategyIds) {
      const comparisons: CaseComparison[] = [];
      for (const c of cases) {
        const reference = references.get(c.id)!;
        const candidate = await runOrCache(aspirational, strategyId, c);
        const judged = candidate.error
          ? { judgements: [], judgeCostUsd: 0 }
          : await judgeRun({ judgeModelId, evalCase: c, reference, candidate });
        comparisons.push(
          compareCase(reference, candidate, judged, costCeiling),
        );
      }
      summaries.push(summarizeStrategy(strategyId, aspirational, comparisons));
    }

    const report: EvalReport = {
      generatedAt: new Date().toISOString(),
      goalModelId: goal,
      aspirationalModelId: aspirational,
      goalStrategyId,
      judgeModelId,
      costCeiling,
      strategies: summaries,
    };

    const outDir = path.resolve(process.cwd(), 'evals/results');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    const base = path.join(outDir, `${stamp}_${goal}_vs_${aspirational}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    const md = renderMarkdown(report);
    fs.writeFileSync(`${base}.md`, md);
    fs.writeFileSync(path.join(outDir, 'latest.md'), md);
    log(`\n${md}\nWritten: ${base}.{json,md} and evals/results/latest.md`);
  });
});
